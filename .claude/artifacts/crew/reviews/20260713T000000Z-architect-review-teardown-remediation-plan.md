# Architect Review — Teardown Remediation Plan (six open questions resolved)

*2026-07-13 · Reviewer: architect (design-review pass) · Inputs: `docs/research/20260713-teardown-and-reinvent.md`, `docs/specs/20260713-teardown-remediation-plan.md`, direct source verification (cited below).*

**Scope of this pass:** decide the six open questions the remediation plan explicitly deferred, catch design errors in the proposed fixes, and produce a slice breakdown for Track 1. Not re-litigating the H2 verdict — that work is done and I found nothing in the source that contradicts it.

---

## Decision 1 — Track 1.1 grain: new table, not columns

**Decision: new `extraction_yield` table**, one row per completed (or poisoned) extract job attempt — not columns on `jobs` or `transcripts`.

**Why not columns.** `jobs` (`migrations/001-init.sql:84-93`) is keyed per job attempt and already has `attempts`/`last_error`/`state` — bolting `chunks_in`/`atoms_out` on would conflate retry bookkeeping with yield telemetry and complicate the rolling-rate query (you'd be aggregating across `jobs.payload_json` blobs). `transcripts` (`001-init.sql:22-28`) is one row per raw transcript, but extraction chunks a transcript into N pieces (`05-extract.ts`) — a transcript-level column can't represent per-chunk yield without becoming its own mini-table anyway.

**Why this doesn't become orphan #5.** This repo already has the exact template for this, built and working: `relation_guard_drops` (`migrations/029-relation-guard-drops.sql`) + `checkEntityRelations` (`src/doctor/checks.ts:1231-1290+`). Same shape — append-only counters table, doctor reads it with a volume floor (`MEANINGFUL_USAGE_THRESHOLD = 20`, `checks.ts:483`) before it's allowed to alarm, and it explicitly folds two failure modes that are indistinguishable from the primary table alone into one WARN. `extraction_yield` should be a direct structural copy: `(id, transcript_id, session_id, model, profile, chunks_in, atoms_out, created_at)`, written from the same call site as `repo.complete(job.id)` in the extract worker.

**Non-negotiable per the plan's own constraint:** the migration, the write site, and `checkExtractionYield` (or folded into `checkMemoryHealth`) land in the **same slice**, and the doctor read must have a real `ok:false` branch, not an informational-only message. See Decision 6 (design errors) for the threshold shape — do not alarm on a single zero.

---

## Decision 2 — Track 1.2 fail-safe direction: CONFIRM refuse-to-kill

**Confirmed: on PID/start-time mismatch, `stopLockHolder` refuses to signal and treats the lock as stale (unlink, don't kill).** Verified the current unconditional path at `src/service/instance-lock.ts:124-154` — `stopLockHolder` calls `pidAlive(holder.pid)` (liveness only) then `sendSignal(holder.pid, 'SIGTERM')` with no identity check at all. This confirms finding #1 as described.

Rationale for refuse-over-kill stands: a wedged daemon is hand-recoverable (an operator can identify and kill it explicitly, or it self-heals on the next legitimate service-manager cycle); a killed sibling process is not, and this box has already lost a documented 40-minute run to exactly this class of mistake (`CLAUDE.md`'s "Do NOT" section). **Refuse must not mean silent no-op** — pair the refusal with a WARN-level log line and, ideally, a doctor-visible row ("stale lock detected, PID/start-time mismatch, not signaled") so a genuinely wedged daemon doesn't sit invisibly forever. That closes the only real cost of choosing "refuse."

**Cross-platform identity check — correction to the plan's Windows approach:**
- **Linux:** `/proc/<pid>/stat` field 22 (starttime, clock ticks since boot) — plan's citation is correct, no Node-native alternative exists, this is an established pattern.
- **Windows: the plan's `wmic` suggestion should be replaced.** `wmic` is deprecated and removed on newer Windows builds (Windows 11 22H2+ SKUs no longer ship it by default) — a fix that depends on it is a time bomb. Use PowerShell instead: `(Get-Process -Id <pid>).StartTime`, or the WMI-native `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` selecting `CreationDate`. Neither is Node-native — **there is no way to read another process's start time from Node's own APIs on Windows** (`process.hrtime`/`process.uptime()` are self-only); a shell-out is required. That's an acceptable, already-established cost — `reinstall.ts` and the schtasks XML path already shell out for service management, this is the same class of dependency.
- **Fail-closed on probe failure too:** if the identity check itself errors (PowerShell shell-out fails, `/proc` unreadable, permission denied), treat that identically to a mismatch — refuse to kill. Never let a probe error fall through to "kill anyway"; that would silently reopen the exact bug this fix exists to close.

---

## Decision 3 — Track 1.4: redact at spool-write, for BOTH paths — and no, plaintext-at-rest in the healthy path is not acceptable

**Decision: redact at spool-write time, applied uniformly to every proxy-captured envelope — not a narrower quarantine-only patch.** This resolves the plan's two nested questions with one fix instead of two separate ones.

**The plan overstates the cost of this choice.** I read `src/capture/proxy.ts:798-816` directly: `writeToSpool` is called from inside `setImmediate(...)`, and the comment at lines 801-807 is explicit — *"By the time this fires the forwarded response is already fully complete, so a slow or failing capture here can no longer backpressure it or delay accepting the next request."* Capture is **already decoupled from the client-facing hot path**. The plan frames redact-at-write as "touches the proxy hot path, latency cost" — that framing is wrong for this codebase specifically. Redaction work added before `writeToSpool(opts.dataDir, key, envelope)` at `proxy.ts:795` costs nothing the client can observe. There's no latency tradeoff to weigh here, which removes the entire argument for the narrower quarantine-only patch.

**Answering the bigger question directly: no, plaintext-at-rest in the healthy spool path is not acceptable**, and once you see the capture path is off the hot path there's no remaining reason to accept it. Redact before every write, healthy or malformed. This makes the quarantine-specific redaction question moot by construction — nothing unredacted ever reaches `.quarantine/` because nothing unredacted ever reaches the spool at all.

**Still land as defense-in-depth, unconditionally:** TTL sweep on `.quarantine/`, file permissions matching the keystore, and a doctor canary on quarantine depth/age (mirror the `relation_guard_drops` pattern again — same shape, different subject). These stay valuable even with write-time redaction, because pattern-based redactors don't catch every PII-adjacent shape, and a growing unbounded quarantine directory is its own hazard independent of what's inside the files.

**One implementation note, not a blocker:** `proxyIdempotencyKey` (`proxy.ts:727-730`) hashes the envelope excluding `captured_at`/`session_id`. If redaction runs before the hash, ensure the redaction transform is deterministic (same raw exchange → same redacted output → same key) or idempotency silently breaks. If it runs after the hash (hash raw, then redact before write), that's simpler and avoids the coupling entirely — recommend that ordering to the builder.

---

## Decision 4 — Track 1.5: confirmed safe to drop, evidence not assumption

Checked all three specified consumers directly, not by inference from the research doc:
- `grep -r "messages|artifacts|provider_state" src/sync/` → **no matches**.
- `grep -r "messages|artifacts|provider_state" src/contracts/` → one hit, `llm.ts:33`, a function parameter named `messages: ChatMsg[]` — unrelated to the table, a false positive.
- `grep -rn "INSERT INTO (messages|artifacts|provider_state)"` across all of `src/` → **zero matches**. Confirms zero writers, not just "no writer found in the areas investigated."
- `provider_state`'s only reader is `queryProviders()` at `src/server/queries/dashboard.ts:243-247`, confirmed.
- Checked the sibling plugin repo too (`C:\work\mega\astramemory-plugin\src`) for the same three table-name strings — **zero matches**. The wire contract layer (canonical/legacy envelopes, `AtomWireV1`, etc.) has no dependency on these table names on either side of the wire.

**DROP TABLE migration is safe.** Delete `messages`, `artifacts`, `provider_state`, and the dashboard's dead read (`dashboard.ts:243-247` and its call site). No open question remains here.

---

## Decision 5 — Track 2.5: design the cosine measurement, don't flip the default until it runs

**The measurement.** A same-day, deterministic script (no LLM judge, no new infra):
1. Construct ~30–50 synthetic contradiction pairs spanning fact categories LoCoMo itself exercises — location ("I live in Seattle" / "I live in Austin"), employer, relationship status, numeric facts, preferences. Include short and long phrasings, since embedding geometry is sensitive to surface length.
2. Embed every sentence with the **real production embedder** (mxbai-embed-large, 1024-dim) via the actual embed-provider path — explicitly *not* the deterministic fake embedder `tests/eval/retrieval-eval.test.ts` uses for CI. This is the one place the real embedder's behavior is the thing under test.
3. Compute cosine similarity per pair; report the distribution (min/median/max, % clearing 0.92).
4. **Control group, not optional:** embed an equal-sized set of genuine near-duplicate paraphrase pairs (true duplicates, not contradictions) and compute the same distribution. The question isn't just "do contradictions clear 0.92" — it's whether 0.92 **separates** true duplicates from contradictions at all. If both clusters straddle the threshold, the merge tier's threshold is unsound regardless of what track 2.5 does.
5. Land as a script under `scripts/` or `tests/eval/`, run against a live Ollama instance, not gated into CI (mirrors how the real-embedder requirement is already special-cased elsewhere in this repo).

**Is flipping the default before this measurement safe, unsafe, or moot?** **Unsafe to flip first, and the reason is sharper than "the finding isn't confirmed yet."** Contradiction-detection-on and the merge-tier auto-merge (cosine ≥ 0.92, unconditional, unaffected by the `contradictionDetection.mode` flag per `consolidate.ts`) both act on the *same* semantic-similarity space. If the measurement shows contradicting pairs commonly clear 0.92, the merge tier is **already resolving** those exact cases today — picking a winner by recency/usefulness and collapsing two atoms into one — before contradiction-detection would ever see two independently-live atoms to compare. In that scenario, flipping the flag on is close to a no-op for the highest-value cases, because the merge tier consumed the evidence first. If the measurement instead shows contradicting pairs sit safely below 0.92, the two features are orthogonal and flipping the default is straightforwardly safe.

**Decision: run the measurement before flipping.** It's cheap (one script, one day) and it decides the correct order of operations — either "fix the merge tier's blast radius first, then flip" or "flip now, independently." Shipping the flip without it risks either false safety (nothing changes) or, if the merge tier is later tightened without knowing this interaction, a race between two subsystems reaching for the same evidence.

---

## Decision 6 — Track 3 scope: half of it already shipped, half is dead on paper

This is the biggest correction in this review. **I found code that changes the shape of the question.**

**`src/cli/mcp-stdio.ts` already exists, is wired (`src/cli/index.ts:25,248-251`), and is already merged** (`SLICE_412_MCP-E2E-OVER-STDIO-TRANSPORT`, in `.claude/artifacts/loop/ai-loop/slices/completed/`). Its own doc comment states Design C's thesis for the MCP surface verbatim: *"No daemon lifecycle (no instance lock, no worker, no shipper, no timers): this process is meant to be spawned per-client-session by an MCP host and to exit when that host closes stdin, not to run as a long-lived service."* Spawn-on-demand for MCP tool calls is not a hypothesis requiring a spike — it is shipped code whose cold-start latency can be measured today with `time node dist/cli/index.js mcp-stdio` (boot → `openDb` → `migrate` → provider init → `server.connect`), no new implementation required.

**Secondary question #2 is confirmed fatal, and confirmed narrowly** — not for the whole daemon, specifically for the proxy. `src/proxy/server.ts:349` calls `server.listen(opts.port, opts.host, ...)`, binding an HTTP server that intercepts an LLM SDK's outbound calls. A man-in-the-middle proxy must be listening continuously at a fixed address the client is configured to hit at any point during an arbitrarily long agent session — there is no "spawn per session" answer for a component whose entire job is intercepting requests whose timing it doesn't control. **This kills full daemon elimination on paper**, exactly as the plan worried it might.

The same argument extends to the HTTP `/ingest` wire endpoint (`routes/ingest.ts`) — it's a server other processes (the plugin, the SaaS sync client) push to whenever *they* decide, not on a schedule the daemon controls, so it also needs a bound listener.

**Background jobs.** Confirmed directly in `src/cli/serve.ts:281-341`: `consolidate` (6h), `cleanup` (24h), and spool-drain (30s) are all `setInterval` timers scoped to the running `serve` process, `unref()`'d. Without a persistent process, these need either an OS-level scheduled trigger (reintroducing the exact schtasks/systemd/launchd complexity Track 3 was trying to delete — net-zero on ops surface, just relocated) or they piggyback on whatever persistent process the proxy/ingest requirement already forces to exist. The second option is the only coherent one, since (b)/(c) already require a persistent process to exist regardless.

**Verdict: Track 3 as scoped ("kill the persistent daemon," one number decides everything) is dead. Close it as originally framed.** What survives and is worth doing, cheaply: measure `mcp-stdio`'s cold start (half a day, code already exists), and if it clears ~300ms, document and recommend it as the preferred low-latency transport for the MCP tool-call surface specifically — decoupled entirely from the daemon-elimination framing, since the daemon isn't going anywhere for the proxy/ingest/jobs surface. This should be re-scoped from "Track 3 spike" to a small documentation+benchmark task, not carried forward as an open architectural bet.

---

## Design errors found in the plan

**1. Track 1.1's zero-yield alarm has exactly the false-positive problem the plan itself flags, and the fix is already sitting in this codebase.** `checkEntityRelations` (`src/doctor/checks.ts:1231-1290+`) already solves this identical shape of problem — "is zero real or is zero a sign something's broken" — via `MEANINGFUL_USAGE_THRESHOLD = 20` gating plus folding two indistinguishable failure causes into one WARN. `extraction_yield`'s doctor check must copy this pattern exactly: don't alarm on any single zero-yield job; require a minimum job-volume floor within a rolling window before computing a **rate**, and alarm on the rate crossing a threshold (e.g. >50% zero-yield over the trailing N completed jobs), not on any individual zero. A quiet install with few sessions must stay green. This isn't a new design problem to solve — it's a "use the pattern already in the file" instruction, and the plan should say so explicitly rather than leaving it as an open design question for the builder.

**2. Track 1.3's "schedule doctor on an interval alongside consolidate/cleanup/spool-drain" undersells a real cost difference.** I checked: `llmChatProbe` (`src/doctor/checks.ts:814`, `src/doctor/probes/llm-chat-probe.ts`) makes a real inference call to the configured LLM provider. Unlike consolidate (6h) or cleanup (24h), running the **full** doctor suite on a tight interval means repeatedly hitting Ollama — competing with actual distill jobs for local GPU/CPU, and risking alarm fatigue if thresholds aren't separately tuned per check. **Fix:** split the check suite by cost. Cheap DB-only checks (poison rate, zero-yield rate, quarantine depth, entity relations) can run frequently. The LLM-probe-dependent checks should run on a slower cadence — piggyback on the existing 24h cleanup tick rather than inventing a new short interval for the whole suite. The plan should specify this split explicitly rather than leaving "run doctor on an interval" underspecified.

**3. The Track 2 → Track 1.1 ordering dependency is correct, and should be tightened to a hard gate, not just a recommendation.** Confirmed: you cannot interpret an unexpectedly low temporal/overall number from the 2.2 full-sample rerun without zero-yield telemetry to rule out "the rerun's own extraction silently broke" as the explanation. **Addition to the plan:** 1.1 must not just be *designed* before 2.2 starts — it must be **landed and have accumulated at least one real rate reading** before the full-sample rerun is kicked off. Otherwise the rerun itself becomes unauditable on exactly the axis the whole plan exists to protect.

---

## Recommended Track 1 slice breakdown

The plan currently scopes Track 1 as "four fixes, one slice." **Split it into four slices, not one** — the reasoning is the same pattern this whole investigation is about: bundling a kill-path change, a security-boundary change, and a destructive migration into one diff makes it much more likely a single reviewer misses something subtle in any one of them.

| Slice | Contents | Why isolated |
|---|---|---|
| **1-A** | 1.2 — PID-identity check | Touches the kill path directly (`instance-lock.ts` + its watchdog/reinstall callers). Highest-severity bug in the report; a subtle fail-open here reopens the exact incident this fix exists to close. Self-contained (no schema, no other subsystem), unit-testable in isolation per the plan's own acceptance criterion — no reason to share a diff with anything else. |
| **1-B** | 1.1 + 1.3 together | Tightly coupled by the plan's own constraint — the new table is worthless unless doctor reads it in the same PR, and 1.3 is the mechanism that makes any of Track 1's telemetry actually alarm unattended. This is the highest-leverage slice in the whole plan and deserves the most careful review, specifically on threshold tuning (design errors #1 and #2 above). |
| **1-C** | 1.4 — redact-at-write + TTL + canary | Touches a security boundary (redaction) and the capture path. The plan itself says "needs its own review" — agreed, and it should stay that way even though the latency concern turned out to be unfounded (Decision 3). |
| **1-D** | 1.5 — migration hygiene | Smallest and lowest-risk, but it's a **destructive** migration (`DROP TABLE`). Low risk + irreversible is exactly the combination that warrants an isolated, easy-to-revert diff rather than being buried inside a larger changeset. No time pressure on this one per the plan — sequence it after 1-B/1-C are verified stable so a destructive migration is never the thing blocking the time-sensitive parts of Track 1. |

---

## Summary of the six decisions

1. **1.1 grain:** new `extraction_yield` table, structural copy of `relation_guard_drops` + `checkEntityRelations` — migration, write site, and doctor read land together.
2. **1.2 fail-safe:** confirmed refuse-to-kill on mismatch; pair with a visible WARN so refusal isn't silent; Windows identity check should use PowerShell (`Get-Process`/`Get-CimInstance`), not `wmic` (deprecated); fail-closed if the identity check itself errors.
3. **1.4 boundary:** redact at spool-write for all proxy-captured content, not just quarantine — verified this costs no client-facing latency (capture is already `setImmediate`-deferred past the response). Plaintext-at-rest in the healthy path is not acceptable, and this fix removes it entirely rather than choosing between two partial patches.
4. **1.5 migration:** confirmed safe by direct grep of `src/sync/`, `src/contracts/`, and the sibling plugin repo — zero references anywhere. Drop `messages`, `artifacts`, `provider_state`, and the dead dashboard read.
5. **2.5 ordering:** design the cosine measurement (real embedder, contradiction pairs + duplicate-pair control group) before flipping the default — the merge tier and contradiction-detection compete for the same evidence, so the measurement decides not just "is it safe" but "which one to fix first."
6. **Track 3 scope:** kill it as originally framed — the proxy's bound listener (`proxy/server.ts:349`) makes full daemon elimination dead on paper. But the MCP-tool-call half of the thesis already shipped (`mcp-stdio.ts`, SLICE_412) — re-scope to a half-day cold-start measurement + documentation task, not a redesign spike.
