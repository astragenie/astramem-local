# Teardown Remediation Plan — Tracks 1/2/3

*2026-07-13 · Derived from `docs/research/20260713-teardown-and-reinvent.md` (6-agent adversarial investigation, verdict: **H2 — sound core, accumulated debt; zero of five redesign gates cleared**)*

**Status:** DRAFT — pending architect + architect-reviewer sign-off.

---

## Framing

The investigation refuted 12 of my architectural charges and left a short, specific list. This plan turns the surviving findings into three tracks, sequenced by risk and time-sensitivity.

**The organizing insight:** the worst thing in this codebase is not a bug, it's a **blind spot** — a distill job whose model returns well-formed `{"atoms":[]}` **completes successfully**. A broken extraction model and a quiet week are the same observable state. **Track 1 exists to make the system able to see its own failures. Everything else is downstream of that.**

**Sequencing (REVISED after adversarial review — the original was internally inconsistent and overclaimed).**

The first draft said "all of Track 1 gates Tracks 2+3." That was wrong, and it conveniently delayed the *time-sensitive* work. Corrected:

1. **1.2 (PID-identity check) ships FIRST, alone if necessary.** It is the report's highest-severity **bug**, it fires on a **live ≤3-minute timer right now**, and this repo has an **already-occurred incident of the same failure class** (`CLAUDE.md`'s image-name-kill entry — different code path, identical harm: it destroyed a 40-minute eval run). Everything else in Track 1 is "we cannot *see* failures." **1.2 is "we actively destroy things."** Destroying beats not-seeing. *(Original draft ranked 1.1 above it. That was a severity inversion and the reviewer was right to call it.)*
2. **Track 2's real dependency is much narrower than claimed.** The LoCoMo rerun (2.2) does **not** need the productionized telemetry system of 1.1 — it needs a **one-off, same-day check of that rerun's atoms-per-transcript distribution**, to confirm the run wasn't silently degraded. **Split 1.1: a throwaway rerun-verification script (unblocks 2.2 immediately) vs. the persistent telemetry system (lands on its own schedule).** Do not let a nice-to-have observability system hold a time-sensitive credibility fix hostage.
3. **Track 3 stays a spike, gated on a single measurement**, and may die on paper (see its secondary question #2).

**Track 2 is time-sensitive** — an unsafe benchmark claim is already circulating externally. Treat it as running in parallel with Track 1, not behind it.

---

# TRACK 1 — Safety + the Missing Invariant

**Goal:** the daemon can assert, unattended, that the code on its live path is producing real output — not successfully producing nothing.
**Shape:** four `local patch` / `architectural symptom` fixes. One slice.
**Blocking:** yes — Tracks 2 and 3 both depend on being able to trust a zero.

### 1.1 — Zero-yield telemetry *(highest leverage in the entire report)*

**Problem (finding #5b, CONFIRMED, HIGH).** Two extraction failure surfaces exist and only one is visible:
- **Case A** — raw content empty (the qwen3 thinking-mode bug): no `{` → `tryParseAtoms` returns null → `TransientError` → 3 retries → job poisons. *State-visible* (a poison count exists), though nothing alarms on it.
- **Case B** — model returns well-formed `{"atoms":[]}`: Zod validates, `extractChunk` succeeds with 0 atoms, worker calls `repo.complete(job.id)`. **A normal, successful, zero-yield job.**

The extraction prompt itself *instructs* `atoms: []` for a genuinely empty chunk (`05-extract.ts:~668-670`), so Case B is indistinguishable from correct behavior at **every** layer: not the Zod gate (valid), not the job queue (completes, never poisons), and **not the `poisonDistillSessions` counter — that only increments on job failure.** No table persists an atoms-per-transcript or zero-yield rate (verified against the full CREATE TABLE inventory).

**A wrong model pull, a bad quantization, a silently truncated context window, or a config typo corrupting the prompt all look exactly like a quiet week.**

**ARCHITECT DECISION — new `extraction_yield` table. Copy the pattern this repo already invented for exactly this problem.**

`relation_guard_drops` (migration 029) + `checkEntityRelations` (`doctor/checks.ts:1231`) **already solve the "is this zero real or broken" question** — for entity relations. **Reuse that structure verbatim; do not reinvent it.** Migration + write site + doctor read all land in **one slice**, per the hard constraint (no fifth orphan table).

*This is the plan's own thesis turned on itself: the team solved this once and didn't generalize it. Generalizing it IS the fix.*

**Fix.**
- Persist per-job extraction yield: `transcript_id`, `chunks_in`, `atoms_out`, `model`, `profile`, `captured_at`.
- Compute a **rolling zero-yield rate** — **not** an alarm on any single zero.
- Surface as a **doctor row that can return `ok:false`** (couples to 1.3 — they ship together).

**False-positive control (architect: the fix already exists in-repo).** An agent session that genuinely produces no memories is **normal** — alarming on a single zero would be pure noise. **Reuse the existing `MEANINGFUL_USAGE_THRESHOLD` gating**: only evaluate the rate once there's enough activity for a zero to *mean* something, then alarm on the rolling rate.

**Acceptance:** with a deliberately broken extraction model, `doctor` goes **red within one check interval, with no human inspecting logs.** With genuinely contentless transcripts, it **stays green.** *These two must be distinguishable — that is the entire point of the item.*

**Risk:** low. Additive telemetry, no happy-path behavior change.

---

### 1.2 — PID-identity check in `daemon.lock` *(highest-severity bug)*

**Problem (finding #1, CONFIRMED, HIGH).** `stopLockHolder` (`src/service/instance-lock.ts:124-154`) verifies a `daemon.lock` PID is **alive**, never that it is **the daemon**, then signals it — on Windows, an unconditional force-kill. Called from the Unix hang-watchdog (`watchdog-probe.ts:117-118`) and **every `reinstall` / `--rollback` / `--dev`** (`reinstall.ts:116-118,217,462`).

If the daemon dies hard (SIGKILL / OOM / power loss — anything skipping the graceful handler that unlinks the lock) and the OS recycles that PID before the next watchdog tick (**≤3 min on Unix**), the watchdog kills **whatever unrelated process now holds it.** This box runs the prod daemon, eval-shard daemons, Ollama, and sibling agents' processes — and `CLAUDE.md` already records an image-name kill that destroyed a 40-minute LongMemEval run.

**Proposed fix.** Stamp an identity token in the lock file at acquire time — **process start-time** (`/proc/<pid>/stat` field 22 on Linux; `wmic process where ProcessId=<pid> get CreationDate` / `Get-Process.StartTime` on Windows) plus optionally an executable-path check. Refuse to signal unless PID **and** start-time match. On mismatch: treat the lock as stale, unlink it, do **not** signal.

**Acceptance — BOTH directions required (the first draft only tested one, which is how you'd ship a watchdog that never kills anything):**
- **Negative:** a lock file naming a live PID with a **mismatched** start-time is treated as stale and **never signaled**. Forge a lock with a real PID (the test runner's own) + a bogus start-time; assert `stopLockHolder` refuses.
- **Positive (the one the draft missed):** a lock naming a **genuinely wedged daemon** with a **matching** start-time **is still killed.** Without this test, an implementation bug silently converts "refuse to kill the wrong process" into "refuse to kill anything" — **neutering the SLICE-2 hang-watchdog with no alarm**, and the plan would have called that a pass.

**Risk:** low-medium. Touches the kill path. Fail-safe direction: **prefer refusing to kill over killing the wrong thing** — a wedged daemon is hand-recoverable; a murdered sibling process is not. **But that preference is exactly why the positive test is mandatory.**

---

### 1.3 — Doctor: make it able to fail, and make it run

**Problem (findings #2 + #3, both CONFIRMED, HIGH).**
- `checkMemoryHealth` (`src/doctor/checks.ts:657-694`) computes `poisonDistillSessions` — distinct sessions where **every** distill attempt permanently failed — interpolates it into a message string, and has **exactly one return path: `{ok: true}`**. A 100% poison rate still reports "memory health: OK."
- **Doctor never runs automatically.** `src/cli/serve.ts` has **no import** of `doctor/runner.ts`. All three callers of `runChecks` are manual (`cli/doctor.ts:68`, `cli/init.ts:848`, `cli/providers.ts:74`). **Every canary this repo built to detect "built, wired, never invoked" is itself only invoked when a human remembers to run it.**

**Fix.**
- Give `checkMemoryHealth` a real threshold and an **`ok:false` branch**.
- Schedule `runChecks` from `serve.ts` (joining the existing consolidate/6h, cleanup/24h, spool-drain/30s self-enqueuing jobs — the *scheduling* invariant is already sound; this just joins it).
- Persist the last result; expose via `/health` so a red doctor is visible without shelling in.
- **Do not** make a red doctor kill the daemon. Degraded-start is deliberate. This is about **visibility**, not fail-fast.

**⚠️ ARCHITECT CAUGHT A SELF-DoS — split the cadence.** `llmChatProbe` (`doctor/checks.ts:814`) **makes a real LLM call.** Naively running the *full* doctor suite on a tight interval would hammer the LLM provider forever — turning an observability fix into a resource leak, and on a metered endpoint into **exactly the FEAT-482 incident class** (see 2.5).
- **Cheap DB checks** (poison count, zero-yield rate, quarantine depth): **frequent interval.**
- **LLM-probe checks**: **piggyback on the existing 24h cleanup cadence.** Do **not** create a new tight interval for them.

**Acceptance:** a poisoned distill state turns doctor red **with no human present**; `/health` reflects it; **and the LLM provider sees no meaningful increase in call volume at idle.** *(That last clause is not optional — it is what stops this fix from becoming the next incident.)*

**Risk:** low, **once the cadence split is in.** Without it, medium-high.

---

### 1.4 — Redact at spool-write; TTL + canary on `.quarantine/`

**Problem (finding #4, CONFIRMED, MED-HIGH).** LLM-proxy-captured transcripts are spooled to disk as **plaintext, unredacted** (`src/capture/proxy.ts:700-705,795`) — by design, since "the daemon's stage-0 redaction is the enforcement point" (`routes/ingest.ts:320`). But files failing JSON-parse or schema-validate are quarantined to `.quarantine/` (`src/ingest/spool-drain.ts:96-107`) **before ever reaching that enforcement point.** No TTL. No doctor canary (grepped all of `src/doctor/` — zero references). Weaker file permissions than the keystore.

**The selection effect is the danger: content that breaks a naive parser is disproportionately content containing secrets and control characters.** The malformed exchange most likely to hold a credential is precisely the one that parks permanently as plaintext.

**ARCHITECT DECISION — redact at spool-write, for EVERYTHING. The tradeoff this plan agonized over does not exist.**

The plan weighed "correct boundary but costs proxy latency" against "smaller, safer, leaves the healthy path plaintext." **The latency cost is imaginary.** `proxy.ts:798-808`: capture already runs inside a **`setImmediate`, after the client-facing response is fully complete** — deliberately (ADR-013 Decision 3 / FEAT-458 S3), so *"a slow or failing capture here can no longer backpressure it or delay accepting the next request."*

**A redaction pass there cannot slow down a single client request.** The entire argument for the narrower patch evaporates.

**And the bigger question, answered: no — plaintext-at-rest in the healthy spool path is NOT acceptable.** It was never a quarantine problem; quarantine was just where it became *permanent*. **Redact at spool-write and the whole surface goes away**, instead of choosing which half of it to keep.

Plus: TTL sweep on `.quarantine/`, file permissions matching the keystore, and a doctor canary on quarantine depth/age (`relation_guard_drops` pattern again).

*Note this also retires the acceptance-gap warning below — with redact-at-write there is no "healthy path still plaintext" residue left to track.*

**Acceptance:** a quarantined file containing a synthetic secret has that secret scrubbed. Quarantine depth/age is visible in doctor.

**⚠️ Acceptance gap the reviewer caught — do not let this pass silently.** If the architect picks the "smaller, safer" **redact-on-quarantine** option, the above acceptance criteria are fully satisfied **while the plan's own stated larger risk — plaintext-at-rest in the HEALTHY spool path — remains completely untouched and now untracked.** If that option is chosen, **the healthy-path plaintext risk must be filed as its own explicit open item**, not absorbed into a green checkmark. A passing test that hides the bigger hole is worse than no test.

**Risk:** medium. Touches redaction (a security boundary) and the proxy hot path. **Needs its own review gate — do not bundle into the Track 1 slice review.**

---

### 1.5 — Migration hygiene (cheap, do it in the same slice)

**Problem (finding #10).** **Four tables ship with zero writers.** `evidence_guard_drops` (mig 030 — in-flight on an unmerged branch, legitimate). Plus three **day-one** tables from `001-init.sql` that **nothing has ever written in the repo's history**: `messages`, `artifacts`, and `provider_state`.

**`provider_state` is the worst:** no writer, but the **dashboard reads it** (`src/server/queries/dashboard.ts:245`). It is not dead code — it is an **always-empty dashboard widget shipping to users.**

**Proposed fix.** Delete `messages`, `artifacts`, `provider_state` and the dashboard's dead read. Land `evidence_guard_drops`' guard + canary (or track it as an explicit open FEAT).

**Acceptance / safety net (the draft relied on git-history evidence alone — insufficient for a DROP):** before dropping, **run a live `SELECT COUNT(*)` on each of the three tables against the operator's real production DB.** Git history proves *this repo* never wrote them; it does **not** prove a prior version, a hand-run script, the SaaS sync client, or the plugin never did. **A non-zero count halts the drop.** Evidence-before-destruction — the same standard the rest of this investigation was held to.

**Risk:** low **once the count check passes** — and unbounded if it's skipped. **A destructive migration is not reversible by `--rollback`** (that repoints code, not schema).

---

# TRACK 2 — Make the Number Real

**Goal:** an externally defensible benchmark claim, and the temporal fix that earns it.
**Time-sensitive:** an unsafe claim is already in circulation.
**Depends on:** Track 1.1 (you cannot trust a benchmark delta if you can't tell a real zero from a broken one).

### 2.1 — STOP quoting 45.4 externally *(do this today, costs nothing)*

`docs/specs/20260713-locomo-score-plan.md:8-9,136` states the 0.4540 baseline was measured on a **10% sample, ONE conversation, n=199**, and its own caveats section says **"Full-sample rerun required."** The LoCoMo paper's 41.4 RAG baseline runs the **full ~1986-question set.**

**"45.4 beats the paper's 41.4" is a one-conversation subsample vs. a full-dataset baseline.** Same metric family — genuinely comparable *instrument* — **not** a comparable *sample*. Freeze the external claim until 2.2 lands.

### 2.2 — Full-sample LoCoMo rerun

Rerun on the full set. Publish overall **and** per-category, with **metric, judge, and subset stated inline**. Verify the run wasn't silently degraded by checking its atoms-per-transcript distribution (the throwaway version of 1.1 — see Sequencing).

**Expect the honest full-sample overall to land below 45.4.** The first draft said "plan the messaging now" and then didn't. Here is the branch it was missing:

| Full-sample result | What it means | What we do |
|---|---|---|
| **≥ 41.4** (still beats the paper's RAG baseline) | The claim survives, on an honest sample. | Publish with methodology inline. Lead with the CI-gated-eval angle (2.8). |
| **37.8 – 41.4** (beats full-context GPT-3.5-16K, loses to RAG baseline) | **The current external claim is dead.** We are mid-pack on a benchmark whose ground truth is 6.4% corrupt. | **Retract the "beats 41.4" claim publicly and immediately** — quietly dropping it is worse than correcting it. Pivot the positioning entirely onto the eval-integrity axis (2.8), which does not depend on winning. Land 2.3 (temporal), rerun, and let the *delta* be the story. |
| **< 37.8** | Something is actually wrong, not just oversold. | **Stop. This is a bug hunt, not a messaging problem.** The 23.6 → 45.4 jump came from an extraction-profile change; a full-sample collapse means that profile doesn't generalize. Treat as a P0 investigation. |

**Decide the messaging posture BEFORE the number lands**, so the result cannot retroactively pick the honest option for us. The eval-integrity positioning (2.8) is deliberately chosen because **it is the one claim that holds in every branch of this table** — it does not require us to win.

**✅ RESOLVED — verified against the run manifests. 0.4540 is the LOCAL, zero-account Ollama number.**

```
.claude/worktrees/agent-a0112287d8dd8d401/.eval-data/locomo/runs/
  2026-07-13T14-59-21-798Z/  "extractionProvider": "ollama"             -> F1 0.45401
  2026-07-13T15-49-03-443Z/  "extractionProvider": "codex-subscription" -> F1 0.42778
```

Both manifests confirmed on disk. The **original** score-plan line (`qwen3:8b extract`) was **right all along**, and the codex-subscription run scored **lower** (0.4278).

**But do NOT claim "local beats cloud."** At n=199 / one conversation the gap is **within noise**. The only defensible claim is **"local is not worse"** — which is already a strong result for the zero-account story, and is the one worth telling.

**Open, unresolved, and worth naming:** the extraction bench (`scripts/eval/extraction-bench`, synthetic engineering transcripts) shows a **~14-point cloud-over-local gap** that this LoCoMo run **does not reproduce**. Two benchmarks disagree about the same question. Nobody has explained why. Also untested: qwen3:8b is **not** extraction-bench's top local model (`qwen2.5:7b` ranks higher) — whether that would move the LoCoMo number is unknown.

**Consequences:**
1. **Every published figure states its extraction config inline, cited from a manifest.** An unlabelled "45.4" is the error, regardless of which config produced it.
2. **The full-sample rerun reports BOTH configs**, each cited from its own manifest.
3. **The temporal 12.4 may have two tangled causes** — the missing atom-level validity fields (2.3) **and** extractor quality. Separate them, or the schema fix takes credit (or blame) for an extractor effect.

---

**Process note — the most instructive failure of the session. Recorded because it is worth more than the finding.**

This one baseline config was asserted, in a single session, to be:
- **(a)** `qwen3:8b` — the original doc line. ✅ **Correct.**
- **(b)** "a *bad* extractor → free headroom" — my inference from (a). ❌ Wrong.
- **(c)** "codex-BYO cloud" — operator recollection + my stale memory. ❌ Wrong.
- **(d)** "codex-BYO is fine, just label it" — my over-correction of (c). ❌ Built on a wrong premise.
- **(e)** "**those manifests are fabricated, the delta is unmeasured**" — **my accusation. ❌ WRONG, and the worst of the five.** The manifests exist. My `find` was capped at `-maxdepth 6`; the real path is **8 levels deep** under `.claude/worktrees/`. **I called a correct citation fabricated because my own search was broken — then wrote that accusation into four documents.**

**Five claims. The first one was right. The four "corrections" — all mine, all confident — were wrong.**

The lesson is sharper than "verify your citations," which I already believed and still failed at. It is: **a failed search is not evidence of absence — it is evidence about your search.** I treated `find` returning nothing as proof, when it was proof only that I had run `find` badly. **Absence-of-evidence claims demand more scrutiny than presence-of-evidence claims, not less**, because there is no artifact to check them against — and I applied *less*.

**The structural fix stands and is now doubly earned: the rerun must emit its config from the run manifest, and every downstream doc must cite that manifest by path.** A claim citing a manifest can be checked in seconds. A claim that a manifest *doesn't exist* cannot be checked at all — which is exactly why I got away with it for four documents.

### 2.3 — The temporal fix (Week 2)

**Problem (finding #5, CONFIRMED, HIGH).** `AtomSchema` (`src/distill/prompts/extract.ts:73-96`) has **no `valid_at`/`invalid_at` field on the atom itself** — only on entities and relations. `InsertInput` (`src/storage/memories.ts:6-74,144-162`) has **no `valid_to` param at all**. The bitemporal columns exist and are correct (`migrations/006-atom-v3.sql`); `as_of` filtering is textbook-correct (`search.ts:264-278`). **Nothing populates them.**

**Fix (two parts, and they are NOT the same thing — keep them distinct):**
- **(a) Text-surface date grounding** — ✅ **SHIPPED 2026-07-13.** Merged as **PR #189** (`feat/ws1-temporal-date-grounding`), plus a timezone-offset bugfix in **#191**. Threads `capturedAtMs` into the extraction prompt so relative expressions ("yesterday", "last year") resolve to absolute dates **in the atom's text** — which is what moves the LoCoMo score, since the harness answerer only ever sees `h.text` (`answer.mts:38-52`).
  **Bonus finding from that work (AC-7), which generalizes the fix beyond the benchmark:** real production ingest **already carries a usable per-session anchor** — `buildClaudeEnvelope` and `buildProxyEnvelope` both set `captured_at` at capture time, flowing through the same path the eval harness uses. So this helps live Claude Code / proxy users, not just LoCoMo. Only legacy v0.0 envelopes and direct `/remember` calls have no anchor, and they correctly keep pre-fix behavior.
  **Not yet verified:** whether the local extraction model *reliably performs the date arithmetic* the prompt now asks for. Unit tests prove the plumbing; only the **full-sample rerun** proves the capability. Treat "+7 pts" as an optimistic ceiling — ~1/3 of "when" gold answers are phrased relative to *another* date, which token-F1 penalizes even when the fact is correctly grounded.
- **(b) Structural validity** — ⬜ **STILL OPEN.** Add atom-level `valid_at`/`invalid_at` to `AtomSchema` and `valid_to` to `InsertInput`, and wire the write path. **This earns zero LoCoMo points** (the harness never sets `as_of`) but closes the real product gap: today a genuine "true Jan–Mar, false now" fact still returns as **eternally true**. **(a) shipping does not close (b)** — do not let the green benchmark hide the open product gap.

**This is exactly Graphiti's mechanism** (`_extract_edge_timestamps`, `edge_operations.py:576-620`) at exactly the same pipeline stage — independently converged on by our own architect (`20260713-locomo-architect-design.md:79-107`, scoped "few hours to a day, additive, low-risk"). **Gate 4 did not clear:** this is a wiring gap, not an ontology gap.

**⚠️ Migration hazard the draft did not name.** Part (b) introduces atoms with a populated `valid_to` **into a store where every pre-existing atom has `valid_to = NULL`.** `as_of` filtering (`search.ts:264-278`) reads `valid_from <= T AND (valid_to IS NULL OR valid_to > T)` — so **legacy NULL rows are treated as eternally valid and will always match**, while newly-extracted rows correctly expire. A store with both is **silently inconsistent**: the same question answered `as_of` a past date returns old facts as still-true and new facts as correctly-bounded. **Specify the intended semantics before building** — is NULL "valid forever" (current behavior, and defensible) or "unknown validity" (which would need a distinct sentinel)? **A backfill is likely out of scope** (nothing can reconstruct intervals for already-extracted text), which means the mixed state is **permanent** and must be a deliberate, documented decision — not an accident discovered later.

### 2.4 — Model-swap robustness (ships with 2.3)

- The qwen3 fix is a **regex on the model NAME** (`/^qwen3/i`, `src/providers/llm/ollama.ts:31-37,91-95`) — not capability detection. The config field's **own doc comment names `deepseek-r1` as equally affected**, and only qwen3 is special-cased. A user picking `deepseek-r1` reproduces the "fixed" incident exactly.
- `llmChatProbe` (`src/doctor/probes/llm-chat-probe.ts:19-22`) **never passes `json:true`** — so it never exercises `format:json`, **the exact combination that caused the qwen3 empty-body incident.** A green doctor gives false confidence extraction will work.

**Fix:** capability detection over name-matching; make the probe exercise the **production request shape**. *(With 1.1 in place, this class of failure becomes visible even when the guard misses.)*

### 2.5 — ~~Contradiction detection ON by default~~ → **RETRACTED. DO NOT BUILD THIS.**

> **This item was based on a false finding and is withdrawn in full. A builder executing the original text would have re-triggered a production incident from earlier the same day.** Caught by `crew:architect-reviewer` pre-build; verified directly against `config.ts` before retraction.

**What I got wrong.** The plan (and research finding #9) claimed contradiction detection ships `off`, citing `config.ts:715-716`. That is `DEFAULT_CONTRADICTION_DETECTION` — a **governance-fallback constant**, applied only when a config override fails validation. **The shipped default is `defaultConfig()` at `config.ts:555`: `mode: 'enabled'`.** It is already on.

**What actually happened, hours before this plan was drafted (FEAT-482).** The flip to `enabled` shipped **without a call-count or wall-clock guard on the judge**. It fired **~245 sequential LLM calls against a metered endpoint** (codex-subscription — billed to the operator's personal ChatGPT quota) and **wedged the daemon's sole worker lane for 10+ minutes.** A **dollar-cap** guard was tried and **reverted** (`0b6b3f8`, the second-most-recent commit on main) because **every shipped provider hardcodes `usage.usd: 0`** — a budget check can never trip. The real guards, `maxPerRun: 200` + `maxWallClockMs: 300_000`, are now live (`config.ts:555-569`). The operator has separately set `mode: 'off'` in their own `config.yaml` as a stopgap; that override wins for their instance regardless of the shipped default.

**Also wrong: the risk axis.** The plan worried about *embedding-geometry / auto-merge truth-correctness*. The actual incident was **unbounded cost and duration** — a different failure class entirely. The plan was preparing to defend the wrong flank.

**What survives, narrowed and still worth doing:**
- **(a) Propose-only means recall stays silent about conflicts.** The judge runs and files proposals, but nothing surfaces "these two memories disagree" to a caller at recall time. That gap is real (`consolidate.ts:29,513-555`). **Scope: a caller-visible conflict signal, not a default flip.**
- **(b) The auto-merge truth-correctness question is still unmeasured and still PLAUSIBLE.** Near-duplicate auto-merge (cosine ≥ 0.92) picks a winner by usefulness/importance/recency, **not truth**. Nobody measured whether two genuinely contradicting sentences clear 0.92 with the real embedder (`mxbai-embed-large`, 1024-dim). **Note the config comment at `config.ts:528-530` says `autoAcceptThreshold: null` and calls the knob "the wrong instrument" — read that before touching it.** Design the measurement; do not flip anything on its basis until it exists.

**Lesson to carry:** `file:line` proves code *exists*, not that it is the code that *runs*. A constant named `DEFAULT_*` is not necessarily the default.

### 2.6 — Tag-hygiene hallucination guard *(restored — was wrongly dropped from this plan)*

**Problem (finding #8, CONFIRMED, MED).** Tier-2 LLM tag inference is *told* to pick a repo/project from the supplied `knownPairs` list, but `Tier2ResponseSchema` (`src/tag-hygiene/tier2-infer.ts:32-36`) **validates types only — no membership check.** A hallucinated repo/project name is written straight into `memories.repo` / `memories.project` (`backfill.ts:131-135`) — **provenance columns that recall filters, doctor's usage counts, and sync's tenant-scoping vocabulary all trust.**

**Why it matters more than its severity rating suggests:** the sibling relations pipeline (`filterAtomRelations`, `05-extract.ts:259`) **enforces exactly this guard.** One subsystem learned the lesson and encoded it; its twin didn't. **This is the precise "guard exists on one path, not the other" pattern this plan calls the codebase's core disease** — dropping it while diagnosing the disease was an error.

**Fix:** `.refine()` the schema against `knownPairs` membership. Reject, don't coerce. ~10 lines.

### 2.7 — Small correctness cleanups *(restored)*

- **Judge fallback conflation** (#11): transport/parse failures collapse to the same `FALLBACK_VERDICT` as a genuine semantic "unrelated" (`contradiction-judge.ts:66,97-103`), and `consolidate.ts:551` then skips the pair entirely. Same "success and silent failure are indistinguishable" shape as Track 1.1 — **give it a counter.**
- **Stale proposal ghost rows** (#12): `sweepContainedProposals` uses an INNER JOIN (`consolidate.ts:266-298`), so proposals referencing a hard-erased atom are silently invisible to the staleness sweep. LEFT JOIN + treat a missing row as a fourth staleness case.
- **`materializeRelease` self-heal hazard** (PLAUSIBLE, `release.ts:339-400`): if the recomputed release id matches the currently-serving one but content differs, `rmSync` targets the directory the **live daemon's `.node` is loaded from**. Windows file-lock hard-fail at exactly the moment self-healing is needed. **Needs a "stop the daemon first if the rebuild target is the currently-pointed-at release" branch.** Not confirmed — verify before fixing.

### 2.8 — The positioning asset (currently unused)

LoCoMo's ground truth has **99 corrupted labels in 1,540 questions (6.4% error rate)**, and the standard LLM judge **accepts 62.81% of intentionally wrong-but-topical answers.** That discredits every judge-scored number in the cohort (Mem0's J, Zep's "accuracy"). Combined with CI-gated eval floors (recall@10 ≥ 0.9, NDCG@10 ≥ 0.7 on every push — **nobody else does this; Graphiti's harness is explicitly excluded from CI**):

**astramem is plausibly the only system in this cohort whose number is real — and says so nowhere.** Lead with *"the only agent-memory system whose eval runs in CI and can't quietly stop passing."*

---

# TRACK 3 — ~~Kill the Daemon~~ → **CLOSED AS SCOPED. Re-scoped to a half-day measurement.**

> **Verdict: full daemon elimination is DEAD ON PAPER — killed by the plan's own secondary question #2, exactly as feared. And the half that *is* viable turns out to have already shipped.** Both facts verified directly against source.

**Why it's dead.** `src/proxy/server.ts:349` **binds an HTTP listener.** A MITM proxy **structurally cannot be spawn-per-session** — something must be listening when the client makes its request. Full stop. And the background jobs (`consolidate`/`cleanup`/`spool-drain`, all `setInterval` in `serve.ts:281-341`) would have to move to OS-scheduler triggers — **which relocates the exact ops surface Track 3 existed to delete.** The install layer does not evaporate; it changes shape and stays.

**Why the surviving half is not a hypothesis at all — it already exists.** `src/cli/mcp-stdio.ts` is **built, wired, and shipped** (SLICE_412). Its own doc comment states Design C's thesis **verbatim**:

> *"No daemon lifecycle (no instance lock, no worker, no shipper, no timers): this process is meant to be spawned per-client-session by an MCP host and to exit when that host closes stdin, not to run as a long-lived service."*

**I proposed as a radical redesign a thing this repo already ships.** That is a fitting end for a demolition prompt: the heretical idea was already in the codebase, and the investigation's own dominant theme — *built, wired, and nobody remembers it's there* — applied to the reviewer.

**Re-scoped deliverable (half a day, decoupled from daemon elimination):**
- **Measure `mcp-stdio` cold-start against real shipped code.** No spike scaffolding needed; `tests/smoke/mcp-stdio.e2e.test.ts` already drives it.
- **Document when to use it.** If cold-start is acceptable, `mcp-stdio` is the *right default* for pure MCP consumers — they get no instance lock, no watchdog, no PID-reuse hazard (finding #1 **cannot fire** in this mode), and no install layer at all.
- **The daemon remains mandatory** for the proxy/capture path, background jobs, and sync. That is now a **documented architectural constraint**, not an open question.

**What this means for finding #1:** the PID-reuse kill hazard is scoped to the *daemon* path. Users who only consume MCP can already avoid it entirely today. **That is worth telling them.** (It does not reduce 1.2's urgency — the daemon path is the default and the one running on this box right now.)

---

## Open questions for the architect

1. **1.1 grain:** new `extraction_yield` table vs. columns on `jobs`/`transcripts`? **Constraint: whatever is created must be read by doctor in the same PR** — this repo has four zero-writer tables already, and adding a fifth to fix the observability problem would be a genuinely funny failure.
2. **1.2 fail-safe direction:** on a PID/start-time mismatch, should the watchdog refuse to kill (risking a wedged daemon staying wedged) or kill anyway (risking the current bug)? **Recommend refuse** — a wedged daemon is hand-recoverable; a murdered sibling process is not.
3. **1.4 boundary:** redact-at-spool-write (correct enforcement point, touches the proxy hot path) vs. redact-on-quarantine (smaller, safer, leaves the healthy spool path plaintext-at-rest). **And: is plaintext-at-rest in the healthy spool path acceptable at all?** That's the larger surface and this plan does not resolve it.
4. **1.5 destructive migration:** confirm no external consumer (SaaS sync, plugin) reads `messages` / `artifacts` / `provider_state` before dropping them.
5. ~~**2.5 ordering**~~ — **VOID. The premise was false; see the retraction in 2.5.** Contradiction detection already ships `enabled`, already caused an incident, and is already guarded. **Replacement question for the architect:** given `autoAcceptThreshold: null` and the config comment at `config.ts:528-530` explicitly calling the cosine knob *"the wrong instrument,"* **is the auto-merge truth-correctness concern (2.5b) even live** — or did FEAT-456/482 already close it by moving the decision to the judge? *Answer this before anyone designs a measurement for a risk that may no longer exist.*
6. **Track 3 scope:** is this a 1-day measurement spike, or does the proxy question (secondary #2) kill it on paper before anyone writes code?
7. **NEW — 2.3 mixed-validity semantics:** is `valid_to IS NULL` "valid forever" or "unknown validity"? A backfill is likely impossible, so **the mixed state is permanent.** Decide deliberately. *(See the migration-hazard block in 2.3.)*

---

## Slice breakdown (architect — four slices, not one)

The original plan bundled Track 1 into a single slice. **Split, by blast radius:**

| Slice | Contents | Why isolated |
|---|---|---|
| **1-A** | **1.2 — PID-identity check** | **Ships first, alone.** Kill-path change; wants an isolated blast radius and its own review. Highest-severity bug; fires on a live 3-min timer. |
| **1-B** | **1.1 + 1.3 — zero-yield telemetry + doctor** | Coupled by the plan's own no-orphan-table constraint: the write site and the doctor read **must** land together. |
| **1-C** | **1.4 — redact at spool-write** | Security boundary. Its own review gate. |
| **1-D** | **1.5 — drop the three dead tables** | Destructive and **irreversible** (`reinstall --rollback` repoints code, not schema). Low risk but must not be buried in a larger diff. No time pressure — sequence **after** 1-B/1-C. |

**Track 2 runs in parallel with Track 1** (it is time-sensitive), with one **hard gate**: **1-B must be landed and returning a real reading before the 2.2 full-sample rerun starts** — not merely designed. You cannot trust a benchmark delta from a pipeline that can't tell a real zero from a broken one.

**Track 3** collapses to a **half-day measurement + doc task**, decoupled from everything.

---

## Review status — **SIGNED OFF, with corrections applied**

- **`crew:architect-reviewer`: NEEDS_FIX → all six defects fixed in this revision.**
  Artifact: `.claude/artifacts/crew/reviews/20260713T173000Z-review-teardown-remediation-plan.md`
  The false 2.5 finding **retracted** (verified against `config.ts:555` directly — it ships `enabled`, not `off`, and my recommendation would have re-triggered the FEAT-482 incident); severity inversion corrected (**1.2 ships first**); Track 2's dependency narrowed; dropped findings **#8/#11/#12/`materializeRelease`** restored as **2.6/2.7**; **below-41.4 branch table** added to 2.2; acceptance gaps closed in 1.2 (positive test), 1.5 (live row-count before DROP), 2.3 (mixed-validity semantics).

- **`crew:architect`: six decisions delivered, all folded in.**
  Artifact: `.claude/artifacts/crew/reviews/20260713T000000Z-architect-review-teardown-remediation-plan.md`
  **1.1** → new `extraction_yield` table, reusing the existing `relation_guard_drops` + `checkEntityRelations` pattern. **1.2** → confirm refuse-to-kill; **drop the `wmic` suggestion** (deprecated on newer Windows — use PowerShell `Get-Process`/`Get-CimInstance`); **fail closed if the identity check itself errors**, not only on confirmed mismatch. **1.3** → **split the cadence** (cheap DB checks frequent; LLM probes on the 24h cleanup tick) or the fix becomes a self-DoS. **1.4** → redact-at-spool-write for everything; **the latency objection was imaginary** (`proxy.ts:798-808` — capture already runs in `setImmediate` after the response completes). **1.5** → drop confirmed safe (grepped `src/sync/`, `src/contracts/`, **and the sibling plugin repo** — zero real references). **Track 3** → closed as scoped; **`src/cli/mcp-stdio.ts` already ships the spawn-per-session model**, and `proxy/server.ts:349` binds a listener, so full daemon elimination is dead on paper.

**Both reviews independently verified their key claims against source rather than trusting this plan's citations — which is how the false 2.5 finding was caught before a builder acted on it.**

**Status: READY TO BUILD.** Start with **slice 1-A**.
