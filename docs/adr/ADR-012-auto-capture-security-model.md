# ADR-012: Auto-Capture Security Model — passive, gated, revocable

**Status:** accepted (2026-07-10) · **Date:** 2026-07-09 · **Confidence:** Medium on mechanism tiering; Low on
relevance-gate tuning (untested taxonomy)
**Acceptance note:** spike checklist executed 2026-07-10 (docs/specs/FEAT-455-spike-results.md,
8/9 PASS, independently reviewed PASS). Item 9 (human sign-off) satisfied by the product owner's
explicit 2026-07-10 direction "land hook-tap first; file separate feature for future router
implementation" given with the tier analysis presented. Conditions carried: build order
provenance→config→doctor-row; spike findings 1-3 tracked as FEAT-459 (stage-0 redaction
hardening); finding 4 (no invalidate-reversal primitive) scoped into the FEAT-455 build;
LLM-proxy tier tracked as FEAT-458 with its own future ADR.
**Context:** FEAT-455 (automatic memory capture) proposes observing agent traffic so memory forms
without an explicit `remember`/ingest call — mem0 and Supermemory both do this via a proxy sitting
in the request path. PM triage flagged `pm_technical_risk: 0.9` and set `autonomous_safe: false`
specifically because this is a privacy-sensitive, hard-to-fully-reverse trust surface, and the
2026-07-09 architecture review found the FEAT body's original plan invalid on two points: it
proposed reusing the FEAT-441 durability gate (whose own AC-6 forbids a second use of its
taxonomy — `src/distill/durability-gate.ts:1-11`), and it bundled the MCP tap in with hook capture
as "the safe option" when tool args/results carry file contents, DB rows, and third-party
credentials — a materially different disclosure surface. This ADR is the required gate: FEAT-455
may not be sliced until it is accepted.

## Decision

### 1. Capture mechanism tiers — v1 ships hook-tap only

| Tier | Mechanism | v1 status |
|---|---|---|
| 1 | **Hook-tap** — enriched version of today's hook-driven capture (`src/capture/claude.ts`): denser sampling (e.g. per-turn or short-interval re-read) of transcript content the daemon already ingests via `/ingest/transcript`. No new observation surface — same data, higher frequency. | **Ships in FEAT-455.** |
| 2 | **MCP-tap** — observes MCP tool call args/results. Broader disclosure surface (file contents, DB rows, third-party credentials can appear in tool args). | **Deferred — own risk assessment/ADR required before any build dispatch.** Not part of FEAT-455. |
| 3 | **LLM proxy** — OpenAI-compatible middleman sitting in the model request path. Broadest coverage, but occupies a security-critical position (adds latency, is structurally adjacent to a MITM point even if read-only). | **Explicitly deferred to its own future FEAT.** Out of scope for FEAT-455 entirely — not a "later phase" of this feature. |

v1 = enriched hook capture only. Tier 2 and Tier 3 each require a dedicated ADR before any
implementation work — they are not phases of this one.

### 2. Source-side relevance filter — distinct from the durability gate

A new, standalone module (not `src/distill/durability-gate.ts`, per its own AC-6) gates what gets
written to the ingest spool in the first place, so auto-capture does not spool every turn:

- **Size caps** — a minimum length floor (skip near-empty turns) and a maximum payload cap
  (companion to the spool's existing oversize quarantine, `src/ingest/spool.ts`).
- **Dedup window** — hash-based dedup against the last *K* captured turns per session, so a
  rapid-refiring hook does not re-spool near-identical content.
- **Junk heuristics** — cheap, *structural* checks only (turn shape/length/type), not the
  semantic taxonomy durability-gate owns (`ephemeral_state`, `git_derivable`, `vacuous_negative`,
  `bare_todo`, `path_fragment`). Those five reasons are a post-distillation, formed-atom
  classification; the relevance gate operates on raw pre-distillation turns and must not
  reimplement or approximate that taxonomy.

Downstream, `gateDurability` still runs unmodified at the distill store-write site
(`src/distill/stages/08-embed-index.ts`). The two gates are sequential, non-overlapping layers:
relevance (source, raw text, high frequency) → durability (formation, formed atom, one choke
point). Neither reuses the other's pattern set.

### 3. Scrub requirement — daemon stage-0 redaction is the ship gate

Client-side scrub is **not required before shipping v1**. Today's hook capture already ships
`client_scrub_applied: false` honestly (`src/capture/claude.ts:143-148`) and relies on the
daemon's stage-0 redaction (SEC-3/5) as the single enforcement point — auto-capture does not move
that trust boundary, it only increases the volume and frequency of content crossing it. The gate
this ADR sets is therefore:

- **Required before FEAT-455 ships:** secrets-pattern test coverage exercised specifically against
  auto-captured payload *shapes* (higher frequency, potentially mid-conversation/partial turns —
  distinct from the shape of a manual session-end hook payload) confirming stage-0 redaction still
  catches what it catches today.
- **Tracked separately, not a blocker:** implementing client-side scrub itself. Risk-accepted for
  v1 under the same terms the existing hook path already operates under.

### 4. Consent / disclosure — default OFF, explicit opt-in, reversible

- Default: **OFF** (`capture.autoCapture.enabled: false`).
- Opt-in is explicit: a config key set only via a disclosed prompt in the `init` wizard ("this
  observes your session traffic automatically — turn on?"), never enabled implicitly by an
  upgrade or a default-config write.
- `doctor` gets a new WARN row when auto-capture is ON, showing enabled state and a running count
  of auto-captured items (distinguished from manually-hooked captures by provenance tag) — same
  pattern as the existing dev-pinned WARN row (`src/doctor/checks.ts:786`).
- **Disabling auto-capture offers a purge**, wired to the existing purge tooling
  (`erase_memory`/`invalidate_memory`, or the lifecycle routes at
  `src/server/routes/lifecycle.ts`) scoped to atoms tagged with the auto-capture provenance
  source — turning the toggle off can retroactively remove what it already captured, not just
  stop future capture. Offered, not forced: a user may keep already-formed memories while
  stopping new auto-capture.

### 5. Non-goals

- **Never mutates in-flight traffic.** Hook-tap is structurally incapable of this — it reads an
  already-written transcript file after the request/response it describes has completed. This is
  a property of the mechanism, not a promise layered on top; Tier 2/3 mechanisms will need to
  re-establish this property under their own ADRs, since a live tap does not get it for free.
- **No additional sync gate is needed at runtime.** The daemon's stage-0 redaction already runs
  unconditionally on all persisted content, manual or auto-captured, before it is eligible for the
  cloud shipper — it is not deployment-conditional today and auto-capture does not change that.
  The "hold back sync until the scrub gate passes" requirement is therefore satisfied by
  construction (decision 3's gate is a *ship* gate, applied once, not a per-item runtime check) —
  no new sync-side flag is being introduced, and none is needed.

### STRIDE summary (from the 2026-07-09 architecture review)

| Category | Finding | Mitigation (this ADR) |
|---|---|---|
| Tampering | A live tap could, in principle, alter in-flight traffic | Hook-tap only for v1 — reads post-hoc, structurally non-mutating (decision 5) |
| Information Disclosure | MCP tool args/results can carry file contents, DB rows, credentials | MCP-tap deferred to its own risk-assessed ADR, not bundled as "safe" (decision 1) |
| Information Disclosure | Client-side scrub gap (`client_scrub_applied: false`) would carry more volume under auto-capture | Daemon stage-0 redaction is the ship gate; new secrets-pattern tests against auto-capture payload shapes required (decision 3) |
| Denial of Service | Unfiltered high-frequency capture could flood the ingest spool | Distinct source-side relevance gate (size caps, dedup window, junk heuristics) — decision 2 |
| Repudiation | Passive/invisible capture with no disclosure erodes trust and audit posture | Default OFF, explicit opt-in disclosure, doctor WARN row, purge-on-disable (decision 4) |
| Spoofing / Elevation of Privilege | Not materially changed — auto-capture reuses the existing `/ingest/transcript` authenticated path and adds no new privilege boundary | No additional mitigation required |

## Options considered

1. **Hook-tap only for v1, distinct relevance gate, daemon-gate ship bar (chosen).** Smallest
   change to the trust boundary, reuses the existing enforcement point, defers the two riskier
   mechanisms to their own reviews.
2. **Ship MCP-tap alongside hook-tap as one v1 feature.** Rejected — the architecture review found
   this conflates two different risk tiers; tool-arg content is a materially broader disclosure
   surface than transcript text and deserves its own STRIDE pass.
3. **Ship the LLM proxy as the v1 mechanism (mem0/Supermemory's approach).** Rejected for v1 — it
   sits directly in the live model request path, which is the most invasive of the three tiers and
   the hardest to reason about as a strict side-channel; explicitly punted to its own future FEAT.
4. **Reuse `src/distill/durability-gate.ts` directly for source-side filtering.** Rejected — its
   own AC-6 forbids a second call site for its taxonomy; the raw-turn/pre-distillation filtering
   job is also semantically different from post-distillation atom classification.
5. **Block v1 on shipping client-side scrub first.** Rejected as a hard blocker — it would
   indefinitely stall an already-deprioritized P2 feature; the daemon-side gate already carries
   this weight for the existing hook capture path and auto-capture does not change that trust
   boundary, only its volume.

## Consequences & migration

- New module (name TBD at spike time, e.g. `src/capture/relevance-gate.ts`) implementing decision
  2's taxonomy, with its own config surface (`capture.autoCapture.relevanceGate.*` or similar) kept
  fully separate from `distill.durabilityGate.*`.
- Auto-captured envelopes need a provenance tag (e.g. a `capture_source` or extended `tool` field)
  distinguishable from manual hook captures — required by decision 4 (WARN counts, purge scoping).
- `doctor` gains the new WARN row (decision 4); `init` wizard gains the opt-in disclosure prompt.
- Disable-flow purge wiring against `erase_memory`/`invalidate_memory`/lifecycle routes is new
  integration work, not a new deletion mechanism — it reuses ADR-006's erasure path.

**Spike checklist — must complete before any FEAT-455 slice is dispatched:**

1. Confirm the concrete hook-tap trigger mechanism (per-turn hook vs. short-interval re-read) and
   verify it adds no new observation surface beyond what today's session-end hook already reads.
2. Spec the relevance-gate taxonomy (size caps, dedup window, junk heuristics) as a standalone
   design, reviewed explicitly for zero overlap with the durability-gate taxonomy (AC-6).
3. Write/extend secrets-pattern tests against representative auto-captured payload shapes; confirm
   stage-0 redaction coverage holds under the new shape and frequency.
4. Define the provenance tag for auto-captured envelopes/atoms, sufficient to drive purge-on-disable
   scoping and doctor's count.
5. Wire and validate the disable → purge flow end to end (toggle off retroactively removes
   auto-captured content when the user opts in to that).
6. Add the doctor WARN row (auto-capture ON + count), matching the existing dev-pinned WARN row
   pattern (`src/doctor/checks.ts:786`).
7. Add the `config.yaml` schema fields and the `init` wizard opt-in prompt with disclosure copy.
8. Document the structural argument for why hook-tap cannot mutate in-flight traffic (not just
   assert it).
9. Security/privacy sign-off closing this ADR from `proposed` → `accepted` before slice 1 opens.
