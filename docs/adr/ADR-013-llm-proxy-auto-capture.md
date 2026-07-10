# ADR-013: LLM Proxy Auto-Capture Security Model (FEAT-458, Tier 3)

**Status:** Accepted (2026-07-10 human security review — see "Review decisions"; building
remains gated on the Decision-6 rollout conditions being *met*, which are runtime evidence, not
review sign-off)
**Date:** 2026-07-10 · **Confidence:** Medium on STRIDE/failure-mode analysis (grounded in shipped
Tier-1 evidence); Low on latency-budget numbers (no prototype benchmarked yet)
**Context:** ADR-012 tiers auto-capture into hook-tap (Tier 1, shipped in FEAT-455), MCP-tap
(Tier 2, deferred, own ADR), and LLM proxy (Tier 3, deferred, own ADR — this document). FEAT-458
is hard-gated on this ADR existing and being accepted, and explicitly forbids reusing ADR-012's
hook-tap analysis: hook-tap reads an already-written transcript file after the fact and is
*structurally* incapable of mutating traffic; a proxy sits directly in the live request path and
gets none of that property for free. This ADR re-derives the trust model from scratch for that
reason.

FEAT-455 has since shipped (commit `8cf7cd3`, v0.12.1 line): `src/capture/relevance-gate.ts`,
`src/capture/claude.ts`'s `capture_source` field, migration 024's `capture_source` columns, and
`src/doctor/checks.ts`'s `checkAutoCapture` WARN row are all live. That satisfies FEAT-458's gate
2 clause "FEAT-455 hook-tap must be SHIPPED" literally, but not its stricter clause "and its scrub
gate proven in production use first" — see Decision 6 (rollout gates) for what closes that
distinction concretely; it is not closed by this ADR being written.

## Decision

### 1. STRIDE pass — OpenAI-compatible `/v1/chat/completions` proxy, localhost hot path

| Category | Analysis | Mitigation (this ADR) |
|---|---|---|
| **Spoofing** | Any local process can point its OpenAI SDK `base_url` at the proxy port; the proxy cannot require a second, non-standard auth header on the hot path without breaking wire-compatibility with unmodified OpenAI SDKs (they send exactly `Authorization: Bearer <provider-key>`, nothing astramem-specific). | Default bind `127.0.0.1` only (same `isLoopbackHost` predicate as the main daemon, `src/server/lib/network.ts`) — the OS process boundary, not an app-layer secret, is the primary control on the hot path. The existing `MEMORY_BEARER` gates only proxy *control-plane* routes (status/config), never the `/v1/chat/completions` passthrough itself, since injecting or requiring a second header there breaks byte-transparency (Decision 1's tampering row) and is not something off-the-shelf OpenAI SDKs will supply. Non-loopback bind is out of scope for v1 — no remote-bind mode ships until a dedicated auth design exists. |
| **Tampering** | A live tap is not structurally incapable of mutating in-flight traffic the way hook-tap is (it does not read a file after Claude Code already wrote it — it *is* the channel). This is the central new risk this tier introduces. | Byte-transparent forwarding invariant, enforced as an architectural constraint, not a promise: the forward path streams upstream bytes to the client via a single pipe with no parse-mutate-reserialize step in between. Capture is a **read-only tee**, not a rewrite — it observes a copy of the bytes as they pass, on a code path that cannot write back into the forwarded stream (see Decision 3 for the streaming design that makes this concrete, and Decision 6 for the test that must prove it, mirroring FEAT-455 spike checklist #8's non-assertion standard). |
| **Repudiation** | Passive proxy capture is even less visible to the user than hook-tap (no transcript file to inspect afterward) unless explicitly tagged. | `capture_source` (migration 024, currently only ever `'auto_capture'`) gains a second value, `'proxy'`, so proxy-sourced atoms are distinguishable from both manual and hook-tap capture in doctor counts, purge scoping, and audit. Same `ingest.log` audit trail as every other capture path — no new logging mechanism. |
| **Information Disclosure** | Highest-density surface of any tier: full system prompts, every turn (not just what a client chooses to `remember`), and the **upstream provider's own API key** transiting on every request. This is qualitatively worse than hook-tap, which never sees credentials meant for a third party. | (a) Body content: daemon stage-0 redaction is the enforcement point, same as hook-tap — but this ADR does **not** inherit FEAT-455's "ship now, redaction gaps are a tracked follow-up" posture, because the proxy's volume and latency-adjacency raise the cost of a miss. FEAT-463 (quoted/JSON label redaction gap) must be **shipped and closed**, not just filed, before the capture fork goes live in production — see Decision 6. (b) Provider keys: the capture fork must never receive request/response **headers** at all — not "redact the Authorization value," but structurally exclude headers from what the fork can see (Decision 4). The fork consumes only the request/response **body**, which is the sole capture requirement (message content) and contains no credential by construction. |
| **Denial of Service** | The proxy sits in the hot path of every agent LLM call — a bug here is worse than a hook-tap bug (hook-tap failing loses a memory; a hung proxy hangs every agent turn using it). "Proxy down ≠ agent down" is the FEAT's own explicit framing. | Decision 2 (fail-open forwarding, fail-silent capture) plus Decision 5 (proxy is a separate opt-in process, never required for the daemon or any agent that isn't explicitly configured to use it — an agent not pointed at the proxy is fully unaffected by its existence, uptime, or bugs). |
| **Elevation of Privilege** | Proxy-captured envelopes reuse the same durable spool (`src/ingest/spool.ts`) and the same `/ingest/transcript`-equivalent trust boundary as every other capture path — no new privilege boundary is crossed. | No additional mitigation required, matching ADR-012's own conclusion for hook-tap on this row. |

### 2. Failure-mode decision: fail-open on forwarding, fail-silent on capture — never fail-closed on the user's request

The proxy has two independent jobs with different failure postures:

- **Forwarding (the user-facing job):** always fail open toward the upstream provider. If the
  capture fork throws, times out, or the spool is full, the client's request/response is
  **never** delayed, altered, or rejected because of it. A proxy whose capture path is broken
  must behave identically, from the calling agent's perspective, to a proxy with capture
  disabled entirely. This directly serves the FEAT's own framing ("proxy down ≠ agent down") by
  narrowing it further: even *capture* down must not mean agent down, while the proxy process
  itself is up.
- **Capture (the auto-capture job):** fail silent, not fail closed. A capture failure is logged
  (matching the existing spool/drain error-handling posture in `src/ingest/spool-drain.ts`) and
  dropped — the specific turn is simply not captured. There is no retry-against-the-live-request
  path (retrying would mean holding a reference to request state past the response, reintroducing
  exactly the coupling this decision avoids).
- **Upstream unreachable** is not a proxy failure at all — the proxy forwards whatever the
  upstream returns (error status, timeout) transparently, unchanged, exactly as if the client had
  called the upstream directly. The proxy adds no new error-handling behavior on this path.
- **Spool full / spool write fails:** capture-fork write failure is swallowed at the fork boundary
  (same "best-effort, already-gone-is-fine" posture `spool.ts`'s `deleteSpoolFile` already uses for
  its own failure mode) — never propagated to the response path.
- **Daemon down while proxy up:** explicitly supported, not a failure mode. Decision 5 makes the
  proxy a separate process from the daemon; the capture fork writes directly to the durable spool
  file (the same mechanism `src/cli/capture.ts` already uses independent of daemon availability,
  FEAT-449's AC-8) so proxy capture works whether or not the daemon happens to be running, and
  drains whenever the daemon's spool-drain worker next ticks.

**Rejected: fail-closed (block the request if capture fails).** A proxy that can deny or delay a
live LLM call because of an unrelated capture-path bug converts a memory-formation feature into a
single point of failure for every agent that uses it — the opposite of what "proxy down ≠ agent
down" requires, and a materially worse failure mode than any Tier-1 hook-tap bug (which, at worst,
loses a memory silently; it can never block an agent turn).

### 3. Latency budget: <10ms added p50, streaming SSE never buffered whole

- **Target:** <10ms added p50 latency versus calling the upstream provider directly, measured on
  the non-streaming path (time-to-first-byte plus total request time for the shortest realistic
  completion) and, separately, time-to-first-chunk for the streaming path (the number that matters
  to a user watching tokens render).
- **Measurement:** reuse this repo's existing bench-harness conventions
  (`scripts/eval/extraction-bench/lib/daemon-runner.ts`'s pattern of spawning a real process and
  timing real HTTP calls, not a mocked unit test) rather than inventing a new harness shape. A new
  `scripts/eval/proxy-bench/` directory, structured the same way (fixtures + a runner script +
  a `report.ts`), drives requests through (a) the upstream directly and (b) the proxy pointed at
  the same upstream (or a local mock upstream for CI, to avoid live-provider cost/flakiness in the
  regression suite), and reports the p50/p95 delta. This is a build-slice deliverable (Decision 6,
  hardening slice), not something this ADR benchmarks itself.
- **Streaming design:** the proxy must never buffer an entire SSE response before forwarding it —
  doing so would both violate the latency budget (blocking on the full response before the first
  byte reaches the client defeats the purpose of streaming) and require holding the whole payload
  in memory (a DoS-adjacent concern at scale). The forward path is a single chunk-by-chunk pipe
  from the upstream response stream to the client response stream. The capture fork reads a
  **tee** of that same chunk stream — accumulating its own copy of the SSE chunks independently,
  off the response-write critical path — and only builds/spools the reconstructed message content
  after the stream closes (end-of-stream `[DONE]` sentinel, matching OpenAI's own SSE
  convention). The tee, not the forward path, absorbs any accumulation cost; a slow or backed-up
  tee must never apply backpressure to the client-facing pipe (Decision 2's fail-silent-capture
  posture applies here too — a stalled tee is dropped, not awaited).

### 4. Credential handling

- **Provider keys are forwarded, never inspected.** The `Authorization` header (and any other
  auth-shaped header — `Cookie`, `X-Api-Key`, provider-specific auth headers) is passed through to
  the upstream unchanged, and is **never logged** (the proxy's own access/debug logging must scrub
  or omit these headers entirely, not merely redact their values — the existing daemon's "scrub
  the Authorization header value from any error logs" comment at `src/server/app.ts:102` is the
  precedent to follow, applied here on the forwarding side too).
- **The capture fork never receives headers at all.** Rather than a header allow/deny-list applied
  *after* headers reach the fork (which leaves room for a future edit to add a header to the
  "allowed" set without re-deriving why credentials are excluded), the fork's input type is scoped
  to the request/response **body only** — headers are not part of the data the fork function can
  even reference. This is a structural exclusion, matching FEAT-455 spike checklist #8's standard
  of "absent by construction, not filtered at runtime" (the same standard that check applied to
  `tool_use`/`tool_result` blocks never reaching parsed turns).
- **TLS to upstream is never downgraded.** If the configured `--upstream` URL is `https://`, the
  proxy connects via TLS with standard certificate validation — no insecure-TLS escape hatch, no
  automatic downgrade to plain HTTP even if the client's own request arrived over HTTP from the
  loopback interface.
- **Local bind + optional Bearer on the proxy port:** the hot chat-completions path relies on
  loopback bind (Decision 1's spoofing row) rather than a second Bearer, because a second header
  would break wire-compatibility. Any proxy **control-plane** route (status, config inspection —
  not the passthrough itself) reuses the existing `MEMORY_BEARER` / `safeBearerEqual` pattern
  (`src/server/lib/secure-compare.ts`), consistent with how the main daemon already gates
  everything except `/health`/`/version`.

### 5. Config surface

- `proxy.*` config keys, default **OFF** — no proxy process starts unless explicitly invoked.
- Explicit subcommand: `astramem-local proxy serve --port <N> --upstream <url>`. This is
  deliberately **not** wired into the `init` wizard as a one-click toggle, unlike hook-tap's
  wizard prompt (ADR-012 decision 4) — hook-tap's opt-in is a single yes/no with a safe default;
  the proxy requires an upstream URL and implies the user is about to repoint an existing
  OpenAI-SDK client's `base_url`, a decision with enough context-specific detail (which agent,
  which provider, is the upstream URL correct) that a wizard default would either be wrong or
  meaningless. `init` may print a one-line mention that the proxy subcommand exists, but does not
  prompt for it.
- `doctor` gains a WARN-visibility row for the proxy, following the same `ok: true`-in-both-states
  pattern as `checkAutoCapture` (`src/doctor/checks.ts:963`) — proxy-enabled-and-running is a
  deliberate opt-in, not a misconfiguration, so it is reported for visibility (state + a
  `capture_source = 'proxy'` count) rather than flagged as an error.
- **Disable → purge parity:** turning the proxy off (stopping the subcommand / flipping
  `proxy.enabled: false`) offers the same purge flow ADR-012 decision 4 defined for hook-tap,
  scoped to `capture_source = 'proxy'` instead of `'auto_capture'` — reusing the same
  `erase_memory`/`invalidate_memory` lifecycle routes, not a new deletion mechanism.
- Local-only, no cloud component, per the FEAT's own scope sketch — captured content reaches the
  SaaS backend via the normal shipper, same as every other local capture path.

### 6. Rollout gates and slice decomposition

**"FEAT-455 proven in production," made concrete** (this is the condition FEAT-458 gate 2 sets and
this ADR does not itself satisfy):

1. Auto-capture (`capture.autoCapture.enabled`) has been running in at least one real
   daemon-operator's environment (not just CI/test fixtures) for **14 consecutive days** with no
   rollback to `enabled: false` due to a capture-caused incident.
2. At least one documented instance of a real auto-captured payload being correctly redacted by
   stage-0 in production use (not a synthetic test fixture) — evidence that the scrub gate holds
   under real traffic shapes, not just the FEAT-455 spike's synthetic corpus
   (`docs/specs/FEAT-455-spike-results.md` checklist #3).
3. **FEAT-463 (stage-0 quoted/JSON label redaction gap) is shipped and closed**, not merely filed
   — this ADR treats it as a hard prerequisite rather than a tracked-but-shippable gap, because the
   proxy's volume and prompt-density make that specific miss more likely to be exercised than it
   was for hook-tap.
4. The one open lifecycle gap FEAT-455's own spike flagged (`invalidate()` has no reversal
   primitive, spike checklist #5) is resolved or explicitly re-accepted for the proxy's
   disable→purge flow — a "changed my mind, bring it back" gap is more consequential at proxy
   volume than at hook-tap volume.

**Proposed slice decomposition** (post-gates, per the FEAT body's own ETA framing):

| Slice | Scope | Risk tag |
|---|---|---|
| 0. Design | This ADR + human security sign-off (closes `proposed` → `accepted`) | gate — no code |
| 1. Core proxy | `proxy serve` subcommand, transparent forward (non-streaming + SSE passthrough), loopback-only bind, no capture at all yet | medium — new network surface, but capture-free means Decision 4's disclosure risk isn't live yet |
| 2. Capture fork | Body-only tee, `capture_source: 'proxy'` provenance, spool write, relevance-gate reuse (FEAT-455's `src/capture/relevance-gate.ts`, unmodified) | high — this slice is where Decision 1's information-disclosure row and Decision 3's tee-isolation property must both hold; needs the same non-mutation structural writeup FEAT-455 spike checklist #8 produced, re-derived for a live tap (per this ADR's opening constraint) |
| 3. Hardening | Failure-mode tests (Decision 2's fail-open/fail-silent matrix), latency bench (`scripts/eval/proxy-bench/`), doctor row, disable→purge wiring, config/docs | medium — mostly test/measurement surface, but a latency regression here is a real production risk if missed |

## Options considered

1. **This ADR's model: separate opt-in process, body-only capture fork, fail-open forwarding
   (chosen).** Smallest addition to the existing trust boundary that still closes the "proxy sits
   in the live path" gap ADR-012 flagged as unresolved for this tier.
2. **Embed the proxy inside the main daemon process.** Rejected — couples the daemon's own
   liveness to the proxy's, which directly contradicts "proxy down ≠ agent down" and this ADR's
   own DoS mitigation (Decision 5); a capture-fork bug could then take down memory retrieval too,
   not just capture.
3. **Require a proxy-specific Bearer on the hot passthrough path.** Rejected — breaks
   wire-compatibility with unmodified OpenAI SDKs, which is the proxy's entire value proposition
   (FEAT-458's "any OpenAI-SDK client becomes capturable by changing one base URL"); loopback bind
   is the load-bearing control instead.
4. **Fail-closed on capture-fork errors (block the request).** Rejected in Decision 2 — converts
   a capture bug into an agent-blocking incident, the opposite of the FEAT's own stated goal.
5. **Ship the proxy alongside FEAT-455 as one feature.** Already rejected by ADR-012 itself
   (decision 1, tier 3 "explicitly deferred to its own future FEAT... not a 'later phase'"); this
   ADR does not revisit that call.
6. **Treat FEAT-463 as a non-blocking tracked follow-up, matching how FEAT-455 treated its own
   redaction gaps.** Rejected specifically for this tier (Decision 6, item 3) — the risk calculus
   that made FEAT-455's gaps acceptable (narrow, pre-existing, low relative volume) does not
   transfer to a mechanism whose whole purpose is to raise capture volume and density further.

## Consequences & migration

- `capture_source` (migration 024, already `TEXT`, unconstrained) gains a second live value,
  `'proxy'`, requiring no schema change — the column was already designed to carry more than one
  tag (`NULL` / `'auto_capture'` today).
- A new capture-fork module is required, structurally distinct from `src/capture/claude.ts` (which
  reads a file after the fact) — it consumes a live body stream/tee, not a completed transcript
  file, and must not import or extend `claude.ts`'s file-reading assumptions.
- Reuses, unmodified: `src/capture/relevance-gate.ts` (source-side filtering), `src/ingest/spool.ts`
  (durable write), daemon stage-0 redaction (`src/redact/`), and the ADR-006 erasure path for
  disable→purge. No new deletion or redaction mechanism is introduced by this ADR.
- `doctor` gains one new check function, following `checkAutoCapture`'s exact shape
  (`src/doctor/checks.ts:963`).
- This ADR does **not** unlock slice dispatch by itself — FEAT-458 remains blocked until (a) a
  human with security/privacy sign-off authority accepts this ADR, and (b) Decision 6's four
  rollout-gate conditions are independently verified true, not asserted.

## Open questions for human security review

1. Is 14 days / one production-scrub-evidence-instance / FEAT-463-shipped the right bar for
   "FEAT-455 proven in production," or should this be tightened (e.g. multiple independent
   operators, a longer window) given the proxy's higher blast radius?
2. Does loopback-only bind with no Bearer on the hot path meet this org's bar for a feature whose
   description is literally "any OpenAI-SDK client becomes capturable" — should a non-default,
   opt-in shared-secret mode (accepted at the cost of breaking zero-config wire-compatibility) be
   a required v1 option rather than a future enhancement?
3. Is body-only capture-fork input (headers structurally excluded) sufficient, or should there be
   an additional runtime assertion/test that fails a build if the fork's function signature is ever
   widened to accept headers — i.e., should the "structural exclusion" claim be enforced by a type
   boundary, a test, or both?
4. Does the org want the `invalidate()` reversal-primitive gap (FEAT-455 spike checklist #5)
   resolved as its own prerequisite FEAT before proxy capture ships, or is re-accepting it
   (Decision 6, item 4) sufficient given it already shipped in that state for hook-tap?
5. Slice 2 (capture fork) is flagged high-risk in the table above specifically because it is where
   this ADR's central claim — a live tap can be made as structurally non-mutating as hook-tap's
   post-hoc read — gets tested against real code for the first time. Should slice 2 require its
   own interim review checkpoint (not just the standard reviewer gate) before slice 3 opens?

## Review decisions (2026-07-10, operator security review)

Answers to the open questions above, recorded verbatim as accepted decisions:

1. **Rollout gate bar: accepted as drafted.** 14 days auto-capture enabled with no
   capture-caused rollback + ≥1 real (non-synthetic) scrub-evidence instance +
   FEAT-463 shipped. Clock starts when the operator enables auto-capture on the
   production daemon.
2. **Bind/auth: loopback-only, no shared secret in v1.** Non-loopback bind is
   refused outright. An opt-in shared-secret mode may be filed as a follow-up
   enhancement but is not a v1 requirement.
3. **Header exclusion: enforced by type boundary + regression test.** The capture
   fork's input type carries body-only fields (no headers field exists to leak),
   plus a test asserting a canary header injected at the proxy never appears in
   any spool write. Runtime scanning rejected as unnecessary hot-path cost.
4. **invalidate() reversal gap: HARD PREREQUISITE.** The purge-reversal/audit gap
   from the FEAT-455 spike must be fixed as its own FEAT inside FEAT-458 slice 1
   (design gate) before any proxy capture ships. Re-acceptance rejected — proxy
   capture volume makes a weak disable→purge promise a trust breach.
5. **Slice 2 interim checkpoint: yes.** The capture-fork slice gets its own
   dedicated review checkpoint (byte-transparency + non-mutation evidence) before
   slice 3 opens, in addition to the standard reviewer gate.
