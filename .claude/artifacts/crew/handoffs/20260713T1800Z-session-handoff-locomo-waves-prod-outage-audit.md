# Session handoff — 2026-07-13 — LoCoMo score work, a production outage, and three systemic findings

**Audience:** an auditor picking this up cold, in another session.
**Repo:** `astragenie/astramem-local` · `main` @ `6f5d9ce` (SCHEMA_VERSION 32)
**Prod daemon:** healthy, v0.15.1, schema 32, 15,986 memories.

---

## 0. TL;DR — what an auditor should check first

Ranked by how much I'd want a second pair of eyes on them:

1. **[#190] The self-learning loop has NEVER received a positive signal.** ε is a punishment-only ranking term in production, and the doctor canary reports GREEN. Probably the highest-impact finding of the day and the least validated.
2. **The 45.4 LoCoMo headline is NOT reproducible from `main`.** The harness flags that produced it were never merged (~102 uncommitted lines in a disposable agent worktree).
3. **A production outage** was caused by an agent worktree migrating the live DB. Root cause is structural, filed as #187, **not yet fixed** — the hazard is still live.
4. **WS1 (merged) writes dates into memory text.** Two bugs were caught post-merge (timezone, over-application). Verify no third.
5. **The 10% validation run of WS1 has NOT produced a valid number yet.** Do not trust any figure claiming to be one.

---

## 1. PRODUCTION OUTAGE (resolved, root cause NOT fixed)

**Symptom:** daemon down, would not boot.

**Chain of events:**
- A builder agent in worktree `agent-aed0bb36a968ea6a4` (FEAT-485) applied an **uncommitted** `030-evidence-guard-drops.sql` to the **live production database**. Prod jumped to `user_version=30` with a migration that existed on no branch.
- Independently, PR #184 merged `030-consolidation-judge-runs.sql` — a **second** migration numbered 030.
- `migrate()` keys a migration's identity on **the number alone** (`src/storage/migrate.ts:66`, `applied.has(version)`). Two `030`s ⇒ whichever applied first won; **the other was silently skipped.**
- PR #186 fixed the collision by renumbering judge-runs 030→031. But **renumbering an already-applied migration is unsafe by construction**: a DB that recorded 30 as judge-runs then *skips* 030 (number already applied) and *re-runs* judge-runs as 031 → `CREATE TABLE ... already exists` → **hard boot failure**.
- Production was in exactly that state. The daemon died and `reinstall`'s health check **rolled back to a release that also couldn't boot**.

**Recovery applied (verified on a simulated DB first, then prod, after a full backup):**
```sql
DELETE FROM schema_version WHERE version = 30;
DROP TABLE IF EXISTS consolidation_judge_runs;   -- was empty, 0 rows; script aborts if non-empty
```
Then `reinstall` → 030 + 031 both apply cleanly → schema 31 (now 32). Backup at
`%LOCALAPPDATA%\Astramem\backups\pre-030-recovery-20260713T113403`.

**AUDITOR: two things to verify.**
- `/health` reports `schema_version` from the **SCHEMA_VERSION constant**, not `PRAGMA user_version`. It reported "29" while the DB was at 30. **A health endpoint that cannot see the one condition guaranteeing boot failure is worse than no check.** Still true today.
- I initially asserted "prod is fine, its v30 is evidence-guard." That was an **inference, not a measurement, and it was wrong** — prod's v30 was judge-runs. I should have read the DB. Check whether any other claim in this handoff rests on inference where a measurement was available.

**Filed:** #185 (incident), #186 (fix, merged), #188 (root cause: `schema_version` records no content hash).

---

## 2. Systemic finding: worktree agents are NOT datadir-isolated (#187, NOT FIXED)

`defaultDataDir()` (`src/config/datadir.ts:15`) resolves to `%LOCALAPPDATA%\Astramem` **regardless of which checkout you run from.** A worktree gets its own branch, `dist/`, and `.claude/state/` — but **not its own datadir**.

So any agent in any worktree that runs `serve`/`doctor`/`reinstall`, or a test reaching `migrate()`, hits **the live production database, keystore, and port 7777** — carrying whatever uncommitted schema changes are in its tree.

This has now bitten **twice**: today's outage, and FEAT-466 (a sandboxed `init` overwriting the production bearer token, because the OS keystore is not datadir-scoped either).

The eval harness gets this right (explicit isolated datadir per run). Nothing forces a *build* agent to.

**The hazard is still live.** The only current control is agent discipline, which is not a control.

---

## 3. Systemic finding: the self-learning loop has never learned (#190, NOT FIXED)

Measured on the live prod daemon:

```
Recall usefulness:        0.0% (0/575 atoms used/served)
Usefulness feedback loop: active (0 used, 854 corrected)   <- reports GREEN
```

- **Positive signal (`recall_used`) has NEVER fired.** 575 atoms served in 7 days, zero marked used. `submit_feedback`/`mark_memory_used` are exposed over MCP and work — **nothing in the real usage path calls them.** `src/doctor/checks.ts:612` already admits this verbatim.
- **The 854 "corrections" are not external feedback.** `recordMemoryCorrected()` has **zero callers**. The events are emitted by `src/storage/memory-events.ts:320` on **supersede**, whose caller is `consolidate.ts`'s own **auto-merge**. The system is deduplicating itself and penalizing the loser.
- **Consequence:** `fuse.ts` applies `ε · usefulness` (`epsilon: 0.1`), Laplace-neutral at 0.5. With `used = 0` forever and `corrected` only incrementing, an atom **can be demoted but can never be promoted.** ADR-010's "usefulness → ranking" is a **one-way punishment function** in production, and has been silently biasing retrieval.
- **The canary is fooled.** `feedbackLoopSummary()` reports used+corrected; a nonzero sum reads as "active". 854 self-generated supersedes mask a completely dead positive half. **The canary built to catch `built-wired-never-invoked` is itself defeated by that exact pattern.**

An agent (`fix-feedback-loop`) is running an ε=0.1 vs ε=0 experiment against the ADR-005 floors. **It was explicitly forbidden from fabricating a positive signal** — faking "used" would destroy the thing being measured.

**AUDITOR:** this is the finding I am least sure I have fully characterized. Verify independently.

---

## 4. LoCoMo: state of play

**Baseline (pre-today):** 45.40 token-F1, 7% sample (n=1 conversation, 19 sessions, 199 QA, `--n 1 --seed 42`), **Ollama `qwen3:8b` extract+compact (local, zero-account)**, conversational profile.

### AUDITOR: a config-labeling error was introduced and corrected — verify me

Mid-session, `20260713-locomo-score-plan.md` was edited to assert that **0.4540 was the codex-BYO (cloud) number** and that the qwen3:8b label "was wrong." **That edit was inverted.** I verified against the run manifests (ground truth, not prose):

```
runs/2026-07-13T14-59-21-798Z/run-manifest.json
  "extractionProvider": "ollama"             -> overall_F1 = 0.4540
runs/2026-07-13T15-49-03-443Z/run-manifest.json
  "extractionProvider": "codex-subscription" -> overall_F1 = 0.4278
```

**0.4540 is the LOCAL Ollama number and it BEAT the cloud config (0.4278).** Both runs used `extractProfile: conversational` + `compactionProvider: ollama`; the only variable was the extractor. I reverted the doc to match the manifests.

**The labeling discipline that edit demanded is correct and retained** — every published figure must state its extraction config inline. Only the direction was wrong.

**Honest caveat that survives either way:** n=199, one conversation. The 0.4540-vs-0.4278 gap is **within noise** at this sample size. **Do not claim "local beats cloud."** The defensible claim is "local is not worse" — which is still a strong result for the zero-account story.

**Auditor: please re-derive this from the manifests yourself.** Two people already got the direction wrong in opposite directions, which is exactly why the rerun must emit its config **from the run manifest, not from a hand-maintained spec line.**

| Category | n (%) | F1 | abstain% | F1 when answered |
|---|---|---|---|---|
| temporal | 37 (18.6%) | **12.4** | 30% | **0.18** |
| single-hop | 70 (**35.2%**) | 44.4 | 21% | 0.57 |
| multi-hop | 32 (16.1%) | 35.4 | 19% | 0.44 |
| open-domain | 13 (6.5%) | 33.7 | **54%** | **0.73** |
| adversarial | 47 (23.6%) | 83.0 | 83% | (abstain is correct) |

**Two facts drive everything:**
- **Temporal is not a retrieval problem.** We *answer* 70% of temporal questions and score **0.18** on the ones we attempt.
- **Open-domain is purely a retrieval problem** — best answered-F1 of any category (0.73), abstains on 54%.

**Benchmark-integrity constraint (do not violate):** `scripts/eval/locomo/answer.mts` is a **deliberately fixed cheap answerer** — its docstring says it exists to measure the memory system, not the LLM. It passes **only `h.text`**. Fixes must land in what we STORE or RETRIEVE. **A bitemporal column the answerer never reads is worth zero LoCoMo points.**

### CRITICAL: the 45.4 is not reproducible from `main`

The flags that produced it — `--extract-profile`, `--extraction-provider`, `--compaction-provider` — were **never merged**. They exist as ~102 uncommitted lines in a **disposable agent worktree** (`.claude/worktrees/agent-a0112287d8dd8d401`). If that worktree is pruned, the headline number becomes **permanently unreproducible** and nobody would notice until someone tried to re-run it.

Patch extracted and verified to apply cleanly onto `main`. `ws2-diagnostic` was asked to land it (it owns those two files).

---

## 5. Workstreams

- **WS1 — temporal grounding. MERGED (#189 + #191).** Root cause: of 191 stored memories, **0 contained an absolute date**; every date-bearing memory was an unresolved relative expression ("yesterday", "last year") with no anchor. The session date reached ingest but was **never threaded into the extraction LLM call** — `extract.ts:235-242` documented this gap *verbatim* before we fixed it. Fix: thread `captured_at` into extraction; model resolves relative→absolute ISO **into atom text**.
  - **Bug found post-merge (HIGH, fixed in #191):** the anchor used the **UTC** calendar date. A user in UTC-8 capturing at 21:00 is already "tomorrow" in UTC → "yesterday" resolves to their **today** → a *confidently wrong* date written into `text`. **Strictly worse than the relative phrasing it replaced.** The offset was destroyed at capture (`new Date().toISOString()`), so it was unfixable downstream; #191 preserves the local offset (migration 032).
  - **Still untested / open:** anchor present + atom has NO temporal expression → does the model spuriously stamp a date? That noise lands in `text` and would dilute single-hop. A test was added; **empirical confirmation requires the eval.**

- **WS2 — retrieval diagnostic. IN FLIGHT, not merged.** Classifies each miss as not-in-db / rank-miss / rank-ok. **Two bugs caught in review, both being fixed:**
  - **vecK pool mismatch (methodology bug, would have sent us at the wrong target).** Real answerer: `limit=10` → `vecK = max(40,50) = 50`. Diagnostic: `limit=500` → `vecK = 2000`. `vecK` bounds both FTS5 and vector candidate queries, and `fuse.ts`'s `normalizeScores()` is **min-max over that candidate array** — pool-composition-dependent by construction. So `limit=500` is **not "the same ranking, deeper"; it is a different retrieval system.** Failure mode: finds the atom at rank 6 in the 2000-pool → reports `rank-ok` ("retrieval fine") when the real answerer **never saw it**.
  - **containment() computes only the recall half of overlap** → short gold answers ("yes", a bare name, a date) get false `rank-ok` from one incidental shared token.

- **WS3 — 1-hop graph expansion. KILLED.** Not for sample size — a **category error**. FEAT-481 §4.3 ("1-hop recall expansion: recommend OUT of v1") set an explicit reopening bar: *"real usage evidence"*. A LoCoMo score is benchmark performance on a synthetic eval; it **cannot clear that bar at any sample size**. **Therefore the full-sample rerun does NOT reopen this** — do not later cite Wave-2 results as having cleared it. Independently confirmed `src/search/*` never queries `entity_relations` (zero hits) — the mechanism is genuinely unbuilt, but deliberately so.
  - **The consistency check that matters:** does that argument prove too much, given WS1/WS2 were justified on LoCoMo evidence? **No** — WS1/WS2 reopen no prior decision that set an evidentiary bar; they complete an acknowledged gap. Only a decision that *set* a bar needs evidence of that bar's shape. This distinction is NOT stated in the WS3 doc and should be, or it will be mis-cited as "benchmarks never count."

- **WS4 — open-domain. DEFERRED.** n=13, only 6 answered. Too thin to design against. Revisit after a full-sample run.
- **WS5 — abstention. NOT INDEPENDENT.** 39/152 non-adversarial questions abstained. **Trap:** adversarial scores 83.0 **by abstaining** — a global "answer more" knob trades those points straight back.
- **WS6 — multi-hop via query decomposition. IN FLIGHT.** WS3 killed one *mechanism*, not the category. Built gated/off-by-default. **Carries the same dilution risk WS3 was killed for** (more candidates → min-max renormalization → can displace strong direct hits, hurting single-hop, which has 2.2× multi-hop's mass). **Honest caveat:** if multi-hop misses are dominated by `not-in-db`, decomposition **cannot help** — you cannot retrieve what was never stored. WS2's diagnostic is what settles this.

---

## 6. The 10% validation run — NO VALID RESULT YET

Fired from a clean worktree at `6f5d9ce` with exact baseline params. **It failed and produced a garbage number. Do not trust any figure claiming to be this run's result.**

```
embed preflight failing — serving DEGRADED: ollama: timeout
shard-0 FAILED: timed out after 60000ms waiting for /health status in [ok]
"activeCount": 0        <- ZERO memories ingested
Total wall clock: 69791ms      <- baseline was ~47 MINUTES
```

The daemon never went healthy, **nothing was ingested**, and it then wrote 199 hypotheses against an **empty database** — which scores ≈22 (the abstain floor) and would look like a catastrophic regression that never happened.

**Cause:** Ollama saturated by three concurrent sibling agents. Probed directly: an embed that should take <1s took **47.8s**. Ollama is alive, not hung — just starved. The 60s health gate was marginally too tight.

**Re-run once the agents finish.** This is a resource contention artifact, not a code regression.

### The abstain-floor trap (important, recurring)

LoCoMo category 5 (adversarial) is 22.5% of questions and its **correct** answer is "no information available". **A system with no memory at all scores ≈22.5 by abstaining on everything.** The original 23.62 baseline was essentially that floor — it measured nothing. **Any LoCoMo score near ~22-24 should be assumed broken until proven otherwise.**

---

## 7. What "done" looks like for the validation

**The gate is SINGLE-HOP (was 44.4), not temporal.** If date-stamping polluted atom text, it dilutes the largest category (70 questions, 35%) and a temporal gain becomes a **net loss**. Report single-hop first.

Also watch **adversarial (83.0)** — if the system starts answering things it should decline, those free points evaporate.

---

## 8. Open PRs / agents in flight at handoff

| Agent | Work | State |
|---|---|---|
| `ws2-diagnostic` | Diagnostic + vecK/containment fixes + **land the harness flags** | Uncommitted in shared checkout; told to branch + PR |
| `ws6-multihop` | `src/search/decompose.ts`, query decomposition | Uncommitted **in the shared checkout** (was told to use its own worktree; did not) |
| `fix-feedback-loop` | #190 honest canary + ε experiment | Own worktree (`fix190`) |

**Note:** `ws2` and `ws6` both have uncommitted work in the **shared main checkout**. `tsc` there is currently RED because of `ws6`'s WIP. That is expected mid-flight, not a regression. Nobody should `git add -A` in that tree.

---

## 9. Hard rules (violating these has already caused incidents)

- **NEVER** run `serve`/`doctor`/`reinstall`/`init`, or anything calling `migrate()`, against the **default datadir — it is PRODUCTION.**
- **NEVER** kill processes by image name (`taskkill /IM node.exe`). This box runs the prod daemon, Ollama, eval shards, and sibling agents.
- **NEVER** `git stash` — the stash stack is repo-global across worktrees and has already eaten a sibling's work once.
- **NEVER** modify `scripts/eval/locomo/answer.mts` — it is the fixed answerer; changing it invalidates every benchmark number.
- **NEVER** `git add -A` in the shared checkout while sibling agents have uncommitted work there.

---

## 10. Issues filed today

- **#185** — prod schema drift incident (resolved by #186)
- **#187** — worktree agents are not datadir-isolated (**root cause of the outage; NOT FIXED**)
- **#188** — `schema_version` records only a number, no content hash (**root cause of the collision AND the re-collision; NOT FIXED**)
- **#190** — self-learning loop has never received a positive signal (**NOT FIXED**)

## Merged today

#173, #174, #175, #176, #179, #180, #181, #182, #183, #184, #186, **#189 (WS1 temporal)**, **#191 (timezone fix)**.
