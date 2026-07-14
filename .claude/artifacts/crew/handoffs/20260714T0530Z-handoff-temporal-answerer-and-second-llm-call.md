# Handoff — temporal, the 46% answerer loss, and the second-LLM-call experiments

**Written:** 2026-07-14 ~05:30Z
**Author:** session e08b8f83 (LoCoMo extraction work)
**For:** a parallel session picking up LoCoMo scoring work
**Repo:** `C:\work\mega\astramemory-local`, branch `main` @ `9785785`

---

## 0. Read this first — three claims in CLAUDE.md are now STALE

Do not trust these; I verified each against live source and live data tonight.

| CLAUDE.md says | Reality (2026-07-14) |
|---|---|
| "`AtomSchema` has no atom-level `valid_at`/`invalid_at`" | **FALSE.** It has both (`src/distill/prompts/extract.ts`, issue #205 AC-1). Merged in **PR #216**. |
| "`InsertInput` has no `valid_to` param at all, so nothing populates the correct bitemporal columns" | **FALSE.** `InsertInput.valid_to` exists (`src/storage/memories.ts`), and `src/distill/stages/08-embed-index.ts` maps `atom.valid_at → valid_from` and `atom.invalid_at → valid_to`, behind a validity guard. **Fully wired.** |
| (implied) "building it is the work" | **The work is NOT building it. It is built. The work is finding out why half of it never fires.** |

**Fix CLAUDE.md as part of this work.** A stale "known gap" that says *build X* when X exists is how a session wastes a day re-implementing merged code. (See the `stale-branch-check-before-revive` memory.)

---

## 1. The state of the numbers

**Full LoCoMo suite, n=1986, after PR #283 (compaction fix):**

```
Overall              0.4841   (was 0.4610)
Category-averaged    0.4137   (was 0.4007)   <- the honest number
  multi-hop          0.2809   (282)
  temporal           0.2300   (321)
  open-domain        0.1991   (96)
  single-hop         0.4640   (841)
  adversarial        0.8946   (446)          <- flatters "overall"; it is near-binary
```

Run dir: `astramemory-local-worktrees/compact-profile/.eval-data/locomo/runs/full-codex-nocompact/`
Store (pre-encryption): `memory.sqlite.bak` — **use this one, see §5 footgun.**

**The retrieval diagnosis (single-hop, n=841) — this is the load-bearing table:**

```
rank-ok     386 (46%)   retrieved in top-10, STILL answered wrong   -> ANSWERER, not us
not-in-db   344 (41%)   never became an atom                        -> +17.3 ceiling
rank-miss   111 (13%)   ...only 19 VERIFIED (83% unverified)        -> +0.96
```

**Ranking is worth ~1 point.** FEAT-487 was declined on this basis. Do not reopen it without new evidence.

---

## 2. WORKSTREAM A — temporal (0.2300)

### The thing you must internalize before touching this

**A perfect `valid_to` earns ZERO LoCoMo points.** The harness never sets `as_of`. Bitemporal filtering (`validityFilterClause`, `src/search/search.ts`) is only exercised when a query carries an `as_of` — LoCoMo's never does. The temporal category is answered **from the atom's TEXT**, by the answerer reading it.

So: **temporal is an extraction-into-text problem, not a data-model problem.** A full architecture investigation already concluded this. Do not let anyone tell you the schema needs replacing.

### What I measured tonight (2499 real atoms, codex extraction, conversational profile)

```
valid_to NOT NULL     :    0      <- invalid_at has NEVER been emitted. Not once.
validity_guard_drops  :    0      <- and the guard never refused one either
distinct valid_from   :  423      <- valid_at DOES vary; that half works
```

Read that carefully. It is **not** "the model emits bounds and the guard drops them" — `validity_guard_drops` is 0. **The model never emits an `invalid_at` at all.** The feature is built, wired, merged, and has a **0.0% invocation rate** in production.

### Why (my hypothesis, UNVERIFIED — test it, don't trust it)

The extraction prompt actively discourages it. `src/distill/prompts/extract.ts` ~line 104-108 says a hallucinated `invalid_at` is *worse than none* because it would "silently expire a fact." That framing is correct and defensible — but combined with conversational content where facts are rarely explicitly invalidated, the model may have concluded "never emit one."

### Your job on Workstream A

1. **Write the rate canary FIRST.** Per ADR-015 and the `canary-must-measure-rate-not-existence` memory: a canary must measure the **RATE** of the failure, not the existence of a success. `doctor` currently has no row for "what fraction of atoms carry a validity bound." Add one. **This is the deliverable even if you fix nothing else** — entity extraction was 87% broken for weeks behind a green existence-check, and this is the same hole.
2. **Determine whether 0/2499 is CORRECT.** It might be! If LoCoMo transcripts genuinely never say "I used to work at X but quit in March," then zero is the right answer and the feature is fine. **Sample 30 transcripts by hand and count how many contain an explicit invalidation.** Do this before writing any code.
3. **Only if step 2 shows real invalidations being missed:** A/B the prompt's `invalid_at` framing. Loosen it, measure the emit rate AND the false-positive rate. A hallucinated `invalid_at` silently expires a true fact — that is a worse bug than the one you are fixing. Guard accordingly.
4. **Do NOT expect a LoCoMo score change from any of this.** It earns zero points by construction (no `as_of`). It is a **real product gap** worth closing on its own merits. If you want the temporal *score* to move, that is text-surface date grounding — see PR #189 (shipped) and go further.

### Migration hazard — read before you touch `valid_to`

Legacy rows have `valid_to = NULL`, which `as_of` filtering treats as **"valid forever," not "unknown."** Mixing in atoms with a real `valid_to` makes that mixed state permanent. See `docs/specs/20260713-teardown-remediation-plan.md` §2.3. And the `valid-to-means-unbounded` memory: a prior attempt to populate this column **silently hid still-true facts**, and the bug was in a file the PR never touched. **Any fixture's "now" must be in the PAST.**

---

## 3. WORKSTREAM B — the 46% single-hop answerer loss (THE BIG ONE)

**386 of 841 single-hop questions had the right atom in the top-10 and were still scored wrong.** That is the largest single bucket in the diagnosis and nobody has touched it.

### Why it is unclaimed

Because it is **not our code**. It is:
- **the answerer** — `scripts/eval/locomo/answer.mts`, pinned to `gpt-5-mini`, `reasoning_effort=minimal`, `max_completion_tokens=150`, `k=10`
- **token-F1 scoring** — a correct answer phrased differently scores poorly

### ⚠️ HARD CONSTRAINT — do not break the baseline

**`answer.mts`'s prompt, model, and k are DELIBERATELY FIXED.** Every score in the repo's history was produced with them. Changing them **invalidates all comparisons** — you can no longer say "we improved," only "we changed two things at once."

**Therefore: do not edit `answer.mts` in place. Add a SECOND, opt-in answerer behind a flag**, run both on the same store, and report both numbers. The pinned one stays the baseline forever.

### What to actually test

Split the 386 by failure mode first — **do not optimize before you know what you are fixing.** Dump them (`hypotheses.jsonl` + `sample.json`, `judge.mts` gives per-question scores) and hand-classify ~50:

- **(a) Right answer, wrong words** → token-F1 artifact. Our system is *correct* and scored wrong. **This bucket is not fixable by us and must be reported honestly, not optimized away.** Quantify it — if it is large, the headline number is understated and that is worth saying out loud.
- **(b) Answer present in the 10 atoms, model failed to use it** → answerer capability. `reasoning_effort=minimal` and a 150-token budget are *severe*. This is where a second LLM call earns its keep.
- **(c) Atom retrieved but too vague to answer from** → back to extraction. Our fault. Fixable.

Bucket (c) is the only one that is unambiguously our bug. **Measure the split before building anything.**

---

## 4. WORKSTREAM C — the second LLM call + prompt experiments

The user explicitly asked to "play with second LLM call and prompt." Ranked by expected value:

### C1. Two-pass extraction (HIGHEST VALUE — attacks `not-in-db`, the 41% / +17.3 bucket)

Extract, then a **second call that re-reads the same chunk holding the first pass's atoms** and asks only: *"what durable facts did this miss?"* This is the natural next step after PR #275 (the exhaustiveness checklist), which proved the mechanism works — it recovered a speaker (Caroline) that extraction had erased **entirely**.

The checklist made thoroughness *mechanical inside one call*. A second call makes it *verifiable across two*.

- **Cost:** 2× extraction calls. On codex that is acceptable; the compaction fix already **freed one call per chunk**, so a second extraction pass is roughly **cost-neutral vs. the pre-#283 pipeline.** Say this out loud when someone objects to the cost.
- **Measure:** atoms/session (baseline **9.4** post-#283), and the `not-in-db` bucket in `--diagnose`.
- **Risk:** duplicate atoms. Check `consolidate` dedups them; if not, that is the actual work.

### C2. Answerer with a real reasoning budget (attacks bucket (b) above)

Same `k=10`, same retrieved atoms — only `reasoning_effort` and `max_completion_tokens` change. **Behind a flag, as a second answerer.** This isolates "is the answerer the bottleneck" from every other variable. It is the cheapest experiment in this document and it directly sizes the 46%.

**Note honestly in any writeup:** this makes us *less* comparable to the cheap-answerer baseline, not more. It tells you where the ceiling is; it is not automatically a shippable win.

### C3. Query expansion before retrieval (attacks `rank-miss` — LOW VALUE)

**Worth ~+0.96 points. Probably not worth your time.** Listed only so you know it was considered and priced. Do not start here.

### What NOT to do

- **Do not re-litigate reranking.** Diagnosed at ~1 point. FEAT-487 declined.
- **Do not chase mem0's 92.5 or Letta's 74.0.** Not on our axis: mem0 used **top-200** + an LLM judge; Letta used **filesystem grep with no extraction** + GPT-4o-mini. We are **top-10** + a pinned cheap answerer + token-F1. Comparing them directly is dishonest, and I would rather we publish 0.4841 with an honest method than a flattered number.

---

## 5. Operational footguns — I hit every one of these tonight

1. **Spawning a daemon on an eval datadir with the PROD config ENCRYPTS the store.** I re-served `full-codex-nocompact/datadir` and SQLCipher encrypted it on boot (`memory.sqlite.pre-encryption.bak` appeared; the live file now returns `file is not a database` to plain better-sqlite3). **No data was lost, but use `memory.sqlite.bak` for analysis.** Always pass the isolated eval env (`makeIsolatedEvalEnv`) — or better, don't re-serve an eval store at all.

2. **The eval's `run-status.json` used to lie.** It reported `{phase: "ingesting", sessions_done: 1}` for 90 minutes on a run whose ingest was **complete** (272/272, 2521 atoms). **Fixed in PR #286** — it now has `distill_wait` and `answering` phases. But the lesson generalizes: **when a long-running job's status disagrees with its database, believe the database.** I lost ~90 minutes trusting a status file, and separately an hour trusting a buffered log.

3. **The best liveness check is network connections, not CPU or logs:**
   ```
   Get-NetTCPConnection -OwningProcess <pid> | Where State -eq Established
   ```
   A wedged orchestrator had **1 socket to its own daemon and 0 to Azure**. A healthy answerer had **8 + 8**. That single check is what finally caught the wedge.

4. **`bun run build` before daemon-spawn smoke tests in a fresh worktree** — `tsc --noEmit` is not a build; you will chase a fake regression.

5. **Never kill by image name.** This box runs the prod daemon, eval shard daemons, Ollama, and sibling agents. Kill only PIDs you spawned; find them by listen port.

6. **`qwen3.5:4b` is NOT viable for conversational extraction** — 1.0 atoms/session vs codex's 9.4, *with* the #275 checklist. Its 68% F1 was on **engineering** fixtures. **Codex stays the extraction path.** Do not re-run this A/B; it is settled.

---

## 6. Suggested order

1. **Fix the stale CLAUDE.md claims** (§0). Cheap, and it stops the next session wasting a day.
2. **Hand-classify 50 of the 386 rank-ok failures** (§3). ~2 hours, and it tells you whether Workstream B is even ours to fix. **Do this before writing any code.**
3. **C1, two-pass extraction** (§4). Highest expected value; attacks the 41% `not-in-db` bucket that the diagnosis says is the real lever.
4. **The `invalid_at` rate canary** (§2, step 1). Small, and it closes an ADR-015 hole that is currently 0.0% invoked behind no alarm.
5. **C2, answerer budget** (§4), as a *diagnostic* to size the ceiling — not as a shippable win.

## 7. What I would tell you if you only read one line

**Ranking is a dead end (~1pt). The two live levers are `not-in-db` (+17.3, attack with two-pass extraction) and the 46% answerer bucket (measure it before you touch it — a large chunk of it may be token-F1 scoring us wrong on answers that are actually correct, and that part is not ours to fix and must be reported, not optimized).**
