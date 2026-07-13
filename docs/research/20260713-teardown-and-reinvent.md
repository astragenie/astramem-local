# Teardown & Reinvent — astramem-local

*2026-07-13 · Protocol: `docs/prompts/20260713-teardown-and-reinvent.md` · 6 read-only investigators, adversarial verification, CONFIRMED/PLAUSIBLE/REFUTED evidence standard*

---

## 1. VERDICT

**H2 wins — decisively. astramem's core architecture is sound; what it has is accumulated integration debt and a missing observability invariant.** The atom primitive is not the problem, the bitemporal schema is correct, and the temporal failure that motivated this entire investigation is a **missing field on one Zod schema plus an unthreaded parameter** — a few hours of work, not an ontology change.

**Zero of the five §2 redesign gates cleared.** Gate 4 (ontology-derived competitor advantage) is the one that mattered, and it failed on direct evidence: Graphiti's temporal advantage comes from threading the session date into the *extraction* LLM call (`edge_operations.py:576-620`) — **the identical mechanism astramem's own architect independently proposed the same day** (`docs/specs/20260713-locomo-architect-design.md:79-107`) as a one-day additive change. Two independent investigations converged on the same fix at the same pipeline stage. That is an implementation gap, not an ontological one.

**What would have flipped me:** if Graphiti's win had come from graph traversal or automatic contradiction-driven edge invalidation that a flat atom+columns model structurally cannot reach; if ≥3 subsystems were independently paying a tax caused by the *atom primitive*; or if the bitemporal columns had turned out to be system-time in disguise. All three were checked. All three came back negative.

**The uncomfortable part:** the investigation vindicated the architecture and **damaged the headline number.** See §3.

---

## 2. THE VERDICT GATE — scored

| Gate | Cleared? | Evidence |
|---|---|---|
| **1. Structural impossibility** | ❌ NO | Temporal facts are fully expressible. `migrations/006-atom-v3.sql` has correct valid-time columns; `search.ts:264-278` has correct `as_of` half-open-interval filtering. Nothing populates them — that's a write path, not an ontology. |
| **2. Triple-subsystem contagion** | ❌ NO — **and this one was argued honestly against the count** | The orphan-table sweep found **4 tables with zero writers** (≥3, numerically clearing the bar). But the investigator who found them **argued against his own evidence**: three (`messages`, `artifacts`, `provider_state`) are **day-one schema from an abandoned early design** the implementation walked away from without pruning; the fourth is mid-flight. **None are downstream of the atom discarding information.** Gate 2 asks whether the *primitive* causes recurring complexity — this is a **migration-hygiene process gap**, not ontology contagion. Counted as **process evidence for Design A's "ruthless cutting," not Gate-2 evidence.** *(Tipping condition, stated in advance: a third live, non-day-one, non-abandoned instance of ship-schema-ahead-of-writer would flip this.)* |
| **3. Compensating mechanism** | ❌ NO (narrowly) | `doctor`'s canaries ARE a compensating mechanism — but for a missing *health-assertion* invariant, not for information the atom discards. Gate 3 requires the core abstraction to lose essential information. It doesn't. |
| **4. Ontology-derived competitor advantage** | ❌ NO | **The decisive gate.** Graphiti fixes temporality at the extraction stage, exactly where astramem must. Same mechanism, same stage. See §6. |
| **5. Migration-cost parity** | ❌ NO | Incremental fix ≈ 1 day. Migration ≈ months. Not remotely at parity. |

**No gate cleared → per §2 of the protocol, the answer is Design A (Sharpened Knife). Default to salvage.**

---

## 3. THE LOCOMO SCOREBOARD — and a problem with our own number

### 3a. The number we've been quoting may not be safe to quote

`docs/specs/20260713-locomo-score-plan.md:8-9,136` states the current baseline — token-F1 **0.4540** — was measured on a **10% sample, ONE conversation, n=199**, with its own "Global caveats" section saying: *"Full-sample rerun required."* The LoCoMo paper's baselines (41.4 RAG, 37.8 GPT-3.5-16K) run the **full ~1986-question set**.

**"45.4 beats the paper's 41.4" is therefore a one-conversation subsample vs. a full-dataset baseline.** Same metric family — genuinely comparable *instrument* — but not a comparable *sample*. **Do not repeat this externally until the full-sample rerun lands.** This is the single most actionable finding in the report.

### 3b. The cohort scoreboard

| System | Score | Metric | Comparable to our F1? |
|---|---|---|---|
| LoCoMo paper — human ceiling | 87.9 | token-F1 | ✅ reference ceiling |
| LoCoMo paper — best RAG | **41.4** | token-F1 | ✅ **the number we claim to beat** |
| LoCoMo paper — GPT-3.5-16K full-context | 37.8 | token-F1 | ✅ |
| **astramem-local** | **45.4** (temporal 12.4 · adversarial 83.0 · single-hop 44.4 · multi-hop 35.4 · open-domain 33.7) | token-F1, no LLM judge | ⚠️ same metric, **n=199 / 1 conversation** |
| **Mem0 (paper)** | F1: single-hop 38.72 · multi-hop 28.64 · open-domain 47.65 · **temporal 48.93**. Adversarial *excluded* | **reports F1 too** | ✅ **the only honest head-to-head** |
| Zep/Graphiti | 84% → recalculated 58.44% → counter-claimed 75.14% | LLM-judge "accuracy" | ❌ **and LoCoMo appears nowhere in Zep's own arXiv paper (2501.13956)** — every claim traces to a contested blog post |
| Letta/MemGPT | 74.0% | undisclosed metric + judge | ❌ |
| Cognee | unlabeled bar chart, no axis | — | ❌ **refuse to cite** |
| Supermemory | no score published | — | ❌ |

### 3c. Where we actually stand

**Against Mem0 — the only vendor with a directly F1-comparable number:**
- ✅ **We win single-hop** (44.4 vs 38.72) and **multi-hop** (35.4 vs 28.64).
- ❌ **We lose open-domain** (33.7 vs 47.65).
- ⚠️ **The "we lose temporal 4×" claim collapsed under verification.** Mem0's temporal F1 (48.93) *looked* like the one clean comparable loss. But OSS Mem0's `add(timestamp=…)` **raises `ValueError`** — timestamped input is paywalled out of the open-source package entirely. So 48.93 was measured against either a pre-paywall build or the managed platform, **not against anything an OSS user can run.** Reclassified from "clean comparison" to **flag, don't headline.**

**The honest state: we do not have a single trustworthy competitor temporal number to lose to.** That is bad news for external triangulation — and *good* news for the verdict, because it removes the strongest-looking piece of "a competitor demonstrably does better" evidence. **Gate 4 is even further from clearing than it first appeared.**

**Against everyone else: no honest ranking is possible.** Anyone claiming "astramem beats Zep's 84%" is comparing incompatible instruments.

### 3d. The benchmark itself is partly broken — and that is *our* advantage

Independent audit (Penfield Labs): **LoCoMo's ground truth has 99 corrupted labels out of 1,540 questions — a 6.4% error rate**, putting the theoretical ceiling near 93.6%. Any vendor number above that is describing something other than correctness. Worse: **the standard LLM judge accepted 62.81% of intentionally wrong-but-topical answers.**

That discredits *judge-scored* numbers — Mem0's J, Zep's "accuracy" — and is a direct point in favor of astramem's deterministic token-F1, which can't be gamed the same way. Combined with the CI-gated eval floors (recall@10 ≥ 0.9, NDCG@10 ≥ 0.7 on every push), **astramem is plausibly the only system in this cohort whose number is real.** That is a marketing asset, and right now it is unused.

---

## 4. FINDINGS

### CONFIRMED — act on these

| # | Finding | Sev | Evidence | Fix class |
|---|---|---|---|---|
| 1 | **`stopLockHolder` can kill an innocent process.** Verifies a `daemon.lock` PID is *alive*, never that it is *the daemon*, then signals it (Windows: unconditional force-kill). Called by the Unix hang-watchdog **and every `reinstall`/`--rollback`/`--dev`**. If the daemon dies hard (SIGKILL/OOM/power-loss — skipping the handler that unlinks the lock) and the OS recycles that PID before the next tick (**≤3 min**), the watchdog kills whatever now holds it. This box runs the prod daemon, eval shards, Ollama, and sibling agents. | **HIGH** | `src/service/instance-lock.ts:124-154`; callers `watchdog-probe.ts:117-118`, `reinstall.ts:116-118,217,462` | local patch — stamp process start-time in the lock, cross-check before signaling |
| 2 | **Doctor's poison-rate check is hardcoded `ok: true`.** `checkMemoryHealth` computes `poisonDistillSessions` (sessions where *every* distill attempt permanently failed), interpolates it into a message string, and **has exactly one return path: `{ok: true}`**. A 100% poison rate still reports "memory health: OK." | **HIGH** | `src/doctor/checks.ts:657-694`; count at `src/server/queries/memory-health.ts:163-173` | local patch |
| 3 | **Doctor never runs automatically.** `serve.ts` has **no import of `doctor/runner.ts`**. All three callers of `runChecks` are manual (`doctor`, `init`, `providers` CLI). **Every canary this repo built to detect "built, wired, never invoked" is itself only invoked when a human remembers to run it.** | **HIGH (architectural)** | `src/doctor/runner.ts:10`; callers `cli/doctor.ts:68`, `cli/init.ts:848`, `cli/providers.ts:74` — no fourth | architectural symptom |
| 4 | **Unredacted plaintext quarantine.** LLM-proxy transcripts spool to disk **before** redaction (by design — "stage-0 redaction is the enforcement point"). Files failing parse/schema are quarantined to `.quarantine/` **before ever reaching that step**. No TTL, no canary (grepped all of `src/doctor/` — zero refs), weaker perms than the keystore. **Selection effect: content that breaks a parser is disproportionately content containing secrets.** | **MED-HIGH** | `src/capture/proxy.ts:700-705,795`; `src/ingest/spool-drain.ts:96-107`; redaction only at `routes/ingest.ts:320` | cross-cutting correction |
| 5 | **Atom-level `valid_to` is never populated.** `AtomSchema` has **no** `valid_at`/`invalid_at` field on the atom (only on entities/relations); `InsertInput` has **no `valid_to` param at all**. The columns exist and work — nothing writes them. *This is the 12.4.* | **HIGH** | `src/distill/prompts/extract.ts:73-96`; `src/storage/memories.ts:6-74,144-162` | cross-cutting correction |
| **5b** | **A broken model and an empty transcript are the same observable state — THE headline bug.** Two failure surfaces at extraction. **Case A** (raw content empty — the qwen3 thinking-mode bug): no `{` → `tryParseAtoms` returns null → `TransientError` → 3 retries → job poisons. At least *state-visible*. **Case B** (model returns well-formed `{"atoms":[]}`): Zod validates, `extractChunk` succeeds with 0 atoms, worker calls `repo.complete(job.id)` — **a normal, successful, zero-yield job.** A wrong model pull, bad quantization, silent context-window truncation, or a config typo corrupting the prompt is **100% indistinguishable from "this transcript genuinely had nothing worth remembering"** — not at the Zod gate (valid), not at the job queue (completes, never poisons), and **not at the `poisonDistillSessions` counter either, which only increments on job *failure*.** No table anywhere persists an atoms-per-transcript or zero-yield rate (verified against the full CREATE TABLE inventory). **There is no code path in this system that can distinguish "the model is broken" from "the model is right and there's nothing here."** Case A is a visibility gap; **Case B is the structural absence of a signal to be invisible about.** | **HIGH** | `src/distill/stages/05-extract.ts:292` (`tryParseAtoms`) + `:102-104` (empty-input short-circuit); prompt language at **`src/distill/prompts/extract.ts:668-670`** ("Empty is valid… output atoms: []") — *citation corrected 2026-07-13: originally given as `05-extract.ts:~668-670`, but that file is only 384 lines. Caught by the ADR-015 writer re-verifying against source instead of trusting this table.* | **architectural symptom** |
| 6 | **The qwen3 fix is a regex on the model NAME** (`/^qwen3/i`), not capability detection. The config field's own doc comment names `deepseek-r1` as equally affected — **only qwen3 is special-cased.** A user picking `deepseek-r1` reproduces the "fixed" incident exactly. | **MED** | `src/providers/llm/ollama.ts:31-37,91-95` | cross-cutting correction |
| 7 | **The LLM probe tests the wrong code path.** `llmChatProbe` never passes `json:true`, so it never exercises `format:json` — **the exact combination that caused the qwen3 empty-body incident.** A green doctor gives false confidence that extraction will work. | **MED-HIGH** | `src/doctor/probes/llm-chat-probe.ts:19-22` vs `stages/05-extract.ts:144-157` | local patch |
| 8 | **Tag-hygiene writes hallucinated repo/project names into provenance columns.** Tier-2 LLM is *told* to pick from `knownPairs`, but `Tier2ResponseSchema` validates types only — **no membership check** before writing to `memories.repo`/`memories.project`, which recall filters and sync's tenant-scoping vocabulary trust. The sibling relations pipeline (`filterAtomRelations`) **enforces exactly this guard.** One subsystem learned the lesson; its twin didn't. | **MED** | `src/tag-hygiene/tier2-infer.ts:32-36`; write site `backfill.ts:131-135` | local patch |
| ~~9~~ | ~~**Contradiction detection ships OFF by default.**~~ **RETRACTED — THIS FINDING IS FALSE.** `defaultConfig()` ships **`mode: 'enabled'`** (`src/config/config.ts defaultConfig()`). The `{mode: 'off'}` at `config.ts` `DEFAULT_CONTRADICTION_DETECTION` (fallback const) is `DEFAULT_CONTRADICTION_DETECTION`, a **governance-fallback constant** used only when a config override fails validation — *not* the shipped default. The investigation cited the fallback constant, and I promoted it to CONFIRMED without checking `defaultConfig()`. **See §9 item 13.** The genuine sub-finding survives, narrowed: propose-only resolution means recall can still return both sides of a contradiction with no caller-visible conflict flag — but the judge *does* run by default and *does* create proposals. | ~~MED-HIGH~~ **RETRACTED** | `src/config/config.ts defaultConfig()` (actual default) vs `:715` (fallback const) | — |
| 10 | **FOUR tables ship with zero writers**, not one. `evidence_guard_drops` (mig 030, in-flight on an unmerged branch) — plus three **day-one** tables from `001-init.sql` that **nothing has ever written in the repo's history**: `messages`, `artifacts`, and `provider_state`. **`provider_state` is the worst**: it has no writer but **IS read by the dashboard** (`src/server/queries/dashboard.ts:245`) — a live query pointed at a table nothing has ever populated. It's not dead code; it's an **always-empty dashboard widget.** | MED | `migrations/001-init.sql`, `030-*.sql`; read site `dashboard.ts:245` | local patch (delete the abandoned three; finish `evidence_guard_drops`) |
| 11 | **Judge failures are indistinguishable from "unrelated."** Transport/parse errors collapse to the same `FALLBACK_VERDICT` as a genuine semantic verdict, and `consolidate.ts:551` skips the pair entirely. Silently costs a legitimate merge, no counter. | LOW-MED | `contradiction-judge.ts:66,97-103` | local patch |
| 12 | **Stale proposals referencing an erased atom are invisible to the staleness sweep** (INNER JOIN silently drops them). Permanent 'pending' ghost rows. Accept fails loudly — no resurrection. | LOW | `consolidate.ts:266-298` | local patch |

### PLAUSIBLE — not laundered into CONFIRMED

- **Near-duplicate auto-merge may pick the wrong fact.** Merge-tier (cosine ≥ 0.92) auto-acts and picks a winner by usefulness/importance/recency — **not truth** — and runs regardless of contradiction-detection state. Whether two genuinely contradicting sentences ("I live in Seattle" / "I live in Austin") actually clear 0.92 was **not empirically measured**. (`consolidate.ts:557-587`)
- **`materializeRelease` self-heal can target the live daemon's directory.** If the recomputed release id matches the currently-serving one but content differs, `rmSync` targets the dir the running daemon's `.node` is loaded from — Windows file-lock hard-fail at exactly the moment self-healing is needed. (`release.ts:339-400`)
- **Stage-8 mid-batch deterministic failure** drops remaining atoms in the batch with no per-atom counter. (`08-embed-index.ts:121-280`)

---

## 5. THE CHARGES

**Charge 1 — "The atom is the wrong unit." → REFUTED. Conceded.**
Steelman that won: the schema has correct three-clock-capable valid-time, cleanly separated from system-time; `as_of` filtering is textbook-correct; the sole gap is two missing Zod fields and an unthreaded param. **A better schema would rescue nothing — the schema is already right.** Verdict: **H2 debt.** Per the protocol's own warning, escalating "the write path is unwired" into "the ontology is wrong" would have been the single most likely path to a false H1. It was avoided.

**Charge 2 — "Success and silent failure are the same observable state." → SUSTAINED. This is the real finding, and it is the one thing worth rewriting the roadmap around.**

The original charge was "the signal exists but nothing forces it in front of a human." The investigation found something **stronger and more specific**: for the most important failure mode in the system, **the signal does not exist at all.**

A distill job whose model returns a well-formed `{"atoms":[]}` **completes successfully** (#5b). Not poisoned. Not failed. Not counted. A wrong model pull, a bad quantization, a silently truncated context window, or a config typo that corrupts the prompt produces **exactly the same observable state** as a transcript that genuinely had nothing worth remembering: a green job, a happy queue, and zero memories. **No table in the schema persists an atoms-per-transcript or zero-yield rate.** The `poisonDistillSessions` counter cannot help — it only increments on *failure*, and these jobs never fail.

That is the precise, named invariant this codebase is missing. Not *"is this code on a live path"* — that one is **mostly solved** (worker poll, consolidate/6h, cleanup/24h, spool-drain/30s all self-schedule from `serve.ts`, each with a comment citing the incident that fixed it). The missing invariant is:

> **"Is the code that IS on the live path producing real output — or successfully producing nothing?"**

Every instance has the identical shape: the neutered poison check (#2), doctor never running unattended (#3), the probe testing a different request shape than production (#7), the judge conflating transport failure with a semantic "unrelated" (#11), and Case B above (#5b). The team **knows this pattern** — they built `relation_guard_drops` and `evidence_guard_drops` precisely to tell a real zero from a broken zero — **but fixed it twice by hand instead of generalizing it into something that catches the next instance by construction.** That is why the guard-drop tables keep getting invented and the disease keeps recurring.

**Not caused by the atom primitive → does not clear Gate 2 → H2 debt. But it is the most important H2 debt in the repo, and it is what the "built, wired, never invoked" folklore has actually been pointing at all along.**

**Charge 3 — "The eval is the product." → SUSTAINED, and worse than charged.**
23.6 → 45.4 came from changing an extraction *profile*, and now we learn the 45.4 is a **one-conversation 10% subsample** while the 41.4 it "beats" is full-dataset. The score measures the prompt *and* the sample. **Verdict: H2 debt — but fix this before it becomes an external credibility problem.**

**Charge 4 — "The install layer is a confession." → PARTIALLY CONCEDED.**
It's the ordinary cost of running a persistent daemon under a general-purpose OS scheduler, done properly once — not a tax three subsystems independently pay. Bearer compare is timing-safe; `/health` leaks nothing; sync cannot resurrect an erased memory (Rule C, order-independent by construction); two-daemon corruption is impossible (lock acquired *before* `openDb`). **But it does harbor the report's most dangerous bug (#1).** Verdict: **H2 debt** — with one lever noted for Design C.

**Charge 5 — "mem0 pays at write, we pay at read, and they're right." → REFUTED, spectacularly.**
mem0's ADD/UPDATE/DELETE memory manager is **dead code with zero callers** (`prompts.py:176`); their real ingest path's system prompt says **"Your sole operation is ADD"**; their dedup is **MD5 equality on exact text**. They *abandoned* write-time resolution and claim **+21 LoCoMo points** for it. Their dead code even has a **passing unit test**. **The market leader independently converged on the append+rank-at-read shape astramem already has.** Verdict: strong **H2 evidence**. *This is the charge I was most confident about, and it was the most wrong.*

---

## 6. COMPETITOR DELTAS

**Core nouns:** mem0 = a flat `Memory` (no versioning, no supersede chain). Letta = a context window (agent self-edits via ~18 tools, unified-diff patching). Graphiti = an `EntityEdge` with `valid_at`/`invalid_at`/`expired_at` as typed `datetime` fields. Supermemory = a versioned Memory with real lineage (`parentMemoryId`, `isLatest`, typed edges) — **but the backend that enforces it is closed-source**; their "embedded graph engine" is a **d3-force canvas renderer**, i.e. presentation, not a graph DB. astramem = four names for one row (`Atom`/`Memory`/`AtomWireV1`/`AtomSnapshot`) — **legitimate per-boundary DTOs, not ontological confusion**, but worth unifying in docs.

**What Graphiti can express that we structurally cannot** (real, and none of it drives the 12.4): multi-source corroboration as a native list (N episodes corroborate one fact without duplicating rows), transitive multi-hop graph traversal, evolving `CommunityNode` summaries, and a narrative-chain `SagaNode` primitive.

**What we got right that they didn't** (required output, and it's substantial):
- **Graphiti** hard-requires **Neo4j and OpenAI as base, non-optional dependencies** — no offline mode exists anywhere in the codebase. **4–6+ LLM calls per episode**, scaling with entity count. Its contradiction detection is a non-deterministic LLM judgment with **no deterministic fallback**, and its temporal query filter is **opt-in, not a safe default** — a naive caller silently retrieves contradicted facts.
- **mem0** paywalls temporal reasoning in OSS: `add(timestamp=…)` **raises ValueError**. There's a 1,582-line `notices.py` whose job is detecting free-tier temporal usage and firing upsell nudges. **The one capability explaining their LoCoMo lead is the one thing OSS users are blocked from testing.**
- **Nobody else** has CI-gated eval floors. Graphiti's harness is *excluded* from CI. Given LoCoMo's 6.4% corrupted ground truth and a judge that accepts 62.81% of wrong answers, **being the only one who can't quietly stop passing is the real moat.**

**The moat question, answered honestly:** it is *not* local-first — mem0 OSS can already run fully local today (faiss + Ollama). The moat is **single-file portability + bitemporal query composability + default-on encryption + an eval that can't be gamed.**

---

## 7. THE THREE DESIGNS

**A — The Sharpened Knife** *(the default per §2, and the pick)*
Fix the extraction gap (#5, thread the session date + add atom-level validity — Graphiti's exact move); kill the PID-reuse hazard (#1); make doctor run automatically and actually alarm (#2, #3, #7); redact at spool-write (#4); replace the qwen3 name-regex with capability detection (#6); add the `knownPairs` membership guard (#8); turn contradiction detection **on by default** (#9). Then **rerun LoCoMo on the full sample** and publish the number with the methodology attached.
*Magic: medium · Temporal fix: YES · Ops surface: shrinks · Migration cost: ~0 · Moat: deepens · Time-to-copy: months (nobody else has CI-gated eval)*

**B — The Temporal Graph** *(adopt Graphiti's ontology)*
**Rejected.** Gate 4 failed: their advantage is at the extraction stage, which A already fixes. Buying it costs Neo4j, a mandatory cloud LLM, and 4–6 LLM calls per ingest — surrendering single-file local-first, the actual moat — to obtain a capability A delivers in a day.
*Migration cost: months · Moat: NEGATIVE (destroys local-first)*

**C — The Heretic: kill the daemon.**
Spawn-on-demand per MCP session; SQLite WAL handles short-lived concurrency; process exits when idle. This **evaporates the entire install layer** — schtasks/systemd/launchd, the shim, the release pointer, rollback, the watchdog — and kills finding #1 at the root (no long-lived lock to go stale). *Hypothesis, not a finding:* the install layer is the largest engineering-effort sink in the repo and the source of both historical outages; deleting it outright may buy more durable user value than any memory feature.
*Validation required before committing: measure cold-start latency per MCP invocation (the whole thesis dies if it exceeds ~300ms), and design where spool-drain/consolidation timers live without a daemon tick.*
*Magic: high · Ops surface: EVAPORATES · Migration cost: high · Time-to-copy: high*

---

## 8. THE PICK — A, then spike C

**Design A. Not because it's safe — because the Verdict Gate says redesign is unjustified and the evidence agrees.**

**Week 1 — stop the bleeding, and build the missing invariant.**
1. **Zero-yield telemetry** (#5b). *The single highest-leverage change in this report.* Persist atoms-per-transcript. Alarm when the zero-yield rate crosses a threshold. **Right now a totally broken extraction model looks exactly like a quiet week.** Everything else in this list is a bug; this is the *absence of the ability to see bugs.*
2. **PID-identity check in `daemon.lock`** (#1). Highest-severity *bug* in the report — it can kill a sibling agent's process, or Ollama, or the prod daemon, on a 3-minute timer.
3. **Redact at spool-write + TTL + canary on `.quarantine/`** (#4). Plaintext secrets at rest.
4. **Doctor: let `checkMemoryHealth` return `ok:false`** (#2) and **run doctor on an interval from `serve.ts`** (#3). Wire the alarm to the siren.

**Week 2 — close the temporal gap.**
5. Thread `capturedAt` into the extraction call; add atom-level `valid_at`/`invalid_at` to `AtomSchema` + `valid_to` to `InsertInput` (#5). Graphiti's exact mechanism; our own architect's exact proposal.
6. Replace the qwen3 name-regex with capability detection; make `llmChatProbe` pass `json:true` (#6, #7). Add the `knownPairs` membership guard (#8). **Delete `messages`, `artifacts`, `provider_state`** and the dashboard's dead read of them (#10).

**Week 3 — make the number real.**
6. **Full-sample LoCoMo rerun.** Publish overall + per-category with metric, judge, and subset stated. Expect temporal to move a lot and overall to move some — and expect the honest full-sample overall to land *below* 45.4.
7. Lead with the thing nobody else can say: **"the only agent-memory system whose eval runs in CI and can't quietly stop passing"** — and cite the 6.4% corrupted-ground-truth and 62.81% judge-gullibility audits as the reason it matters.
8. Turn contradiction detection **on by default** (#9).

Then **spike C** — measure MCP cold-start. If it's under ~300ms, the entire install layer is deletable, and that is a bigger win than any feature on this list.

---

## 9. WHAT I WAS WRONG ABOUT

The integrity check. This section is long, and that is the honest outcome.

1. **"The atom is the wrong unit."** Wrong. The schema is correct bitemporal valid-time, properly separated from system-time.
2. **"Temporality is in the columns, not the type system — that's why we score 12.4."** Wrong, and it was my central thesis. The columns are right and correctly populated; the *extraction* never writes the fact's own validity, and the benchmark only reads atom text anyway.
3. **"Graphiti wins on ontology."** Wrong. It wins on an extraction-stage LLM call we haven't wired.
4. **"mem0 is smarter at write time and we should copy them."** Badly wrong. Their write-time manager is **dead code with zero callers**; they abandoned it and gained 21 points. We already have the shape they converged on.
5. **"Ingest is probably non-atomic."** Wrong. Session + transcript + job enqueue commit in **one transaction**.
6. **"Erase probably resurrects via sync or replay."** Wrong on all three vectors. Rule C is order-independent by construction.
7. **"Two daemons will corrupt the DB."** Wrong. The instance lock is acquired *before* `openDb()`.
8. **"The vec0 table has no FK cascade — there'll be orphans on erase."** Wrong. The vec row is deleted in the *same transaction*, by rowid.
9. **"Crash mid-distill leaves permanent zombies."** Wrong. `recoverOrphans()` runs unconditionally at boot and the vec upsert is unconditional on retry; it self-heals.
10. **"Embed-dim mismatch yields silent garbage similarity."** Wrong — it fails loud (via job poisoning). The real bug is the *boot posture* that accepts traffic with a doomed config.
11. **"`/health` probably leaks something; the bearer compare is probably `===`."** Wrong on both. Timing-safe, leak-free.
12. **"The install layer's complexity proves the deployment architecture is wrong."** Overstated. It's the ordinary cost of a persistent daemon, done properly once — though it does harbor the report's worst bug.

13. **"Contradiction detection ships off by default." — FALSE, and this one is the worst error in the report**, because it survived to CONFIRMED and into a remediation plan. It ships **`enabled`** (`config.ts` `defaultConfig()` → `contradictionDetection.mode`). I cited `config.ts` `DEFAULT_CONTRADICTION_DETECTION` (fallback const) — `DEFAULT_CONTRADICTION_DETECTION`, a **governance-fallback constant** that only applies when an override fails validation. An investigator quoted it, I promoted it without opening `defaultConfig()`, and it propagated into a recommendation to *"turn contradiction detection on by default."*
    **It was already turned on — the same day — and it caused an incident:** ~245 sequential LLM calls against a metered endpoint (billed to the operator's personal ChatGPT quota), wedging the sole worker lane for 10+ minutes (FEAT-482, `330f2e6`/`27eaa5d`). A dollar-cap guard was tried and **reverted** (`0b6b3f8` — every provider hardcodes `usage.usd: 0`, so a budget check can never trip); `maxPerRun` + `maxWallClockMs` are the real guards and are live. **A builder executing my plan verbatim would have re-triggered that incident.** Caught by `crew:architect-reviewer` before any code was written — which is the entire argument for the review gate.
    *Root cause of my error: the exact failure mode §3 of the protocol warns about — `file:line` proves code EXISTS, not that it is the code that RUNS. A constant named `DEFAULT_*` is not necessarily the default.*

**The pattern in my own errors:** I assumed *absence of a guard* wherever I found *complexity*. In almost every case the guard was already there, with a comment citing the incident that produced it. **This codebase is not undefended. It is defended by people who got burned and wrote the invariant down.** What it lacks is not correctness — it's an alarm that rings without a human present.

**And the meta-lesson, paid for in item 13:** the same discipline I demanded of the investigation (verify the *live* path, not the plausible-looking symbol) is the one I failed to apply to its output. The evidence standard has to survive synthesis, not just collection.

---

## 10. BASELINE + INSTRUMENTATION

- Baseline: HEAD `d645e80`, migrations through `031`, Node v24.16.0, bun 1.3.14, pkg v0.15.1, embed dim 1024.
- **Baseline discrepancy, reported not papered over:** I recorded the temporal work as *staged edits* on `feat/ws1-temporal-date-grounding`. Two agents independently found it is a **committed** commit (`3502f97`) on that branch, not staged, and read it via `git show` without checkout. My baseline was wrong; theirs is right. **Findings are attributed to committed `main` @ `d645e80`.**
- **Zero code modified. Zero daemon restarts.** All findings are static traces or documented-incident evidence. No reproduction-only instrumentation was written, so **no failure in this report is self-inflicted.**
- **What was skipped:** prompt-injection surface via sync replay (memory text re-entering a distill prompt); empirical embedding-geometry test for the auto-merge finding; Letta's agent loop; Cognee's retrieval side; MCP-stdio entry-point reachability beyond one level. **Named, not silently dropped.**
