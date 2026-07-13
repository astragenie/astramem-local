# LoCoMo WS1-WS5 — wave execution plan (2026-07-13)

Source: `20260713-locomo-score-plan.md` + `-architect-design.md` + `-architect-review.md`.
The review CORRECTED the plan — read its verdicts before building anything.

## Hard safety constraints (every agent, every wave)

Today an agent worktree migrated the **production** database and took the daemon
down (issue #187). Until that is fixed, these are non-negotiable:

- **NEVER** run `serve`, `doctor`, `reinstall`, `init`, or anything that calls
  `migrate()` against the **default datadir**. It is PRODUCTION.
- Always set `ASTRA_MEMORY_DATADIR` to an isolated path or `:memory:`.
- **NEVER** touch port 7777 (prod daemon) or `%LOCALAPPDATA%\Astramem`.
- **NEVER** `git stash` (stash stack is repo-global across worktrees).
- **NEVER** kill processes by image name (`taskkill /IM node.exe`) — this box
  runs the prod daemon, eval shards, Ollama, and sibling agents.

## Benchmark-integrity constraint (WS1-WS5)

`scripts/eval/locomo/answer.mts` is a DELIBERATELY fixed cheap answerer
("measures the MEMORY system, not the LLM"). **Do not modify it or its prompt.**
It passes only `h.text` — so fixes must land in what we STORE or RETRIEVE.

Tripwire named by the reviewer: when grounding dates into text, **do not converge
the format on LoCoMo's gold-answer phrasing** ("the week before 9 June 2023") to
farm token overlap. Choose a representation for real memory-quality reasons
(ISO-8601: sortable, unambiguous) and treat any score gain as incidental.

## Wave 1 — parallel, no interdependencies (NOW)

| Agent | Workstream | Output |
|---|---|---|
| A1 | **WS1 temporal grounding** | PR. The only BUILD-now item. |
| A2 | **WS2 diagnostic harness** | Script only, no prod code. Runs in Wave 2. |
| A3 | **WS3 design review** | Decision doc. Read-only, no code. |

WS1's evidence is a property inspection of stored text, **independent of eval
sample size** — so it is exempt from the "rerun at full sample first" gate that
holds WS2-WS5.

## Wave 2 — after WS1 merges

- Full-sample LoCoMo rerun **with WS1** → gives both the score delta AND firm
  per-category n (WS4's n=13 and WS3's n=32 are currently too thin to fund).
- Run A2's diagnostic + the **rerank flip** (`crossEncoder.enabled`, already
  built and off-by-default in `src/search/rerank.ts`) against that run.

## Wave 3 — informed by Wave 2

- WS2 fix (direction chosen by the diagnosis, not guessed).
- WS4 / WS5 re-measure. WS5 is very likely downstream of WS1-2, not independent.

## WS3 — KILLED (2026-07-13)

Verdict: **KILL**. See `20260713-ws3-graph-expansion-decision.md`.

Not "insufficient sample size" — a **category error**. FEAT-481 §4.3 gated
reopening on *"real usage evidence"*, meaning a production demand signal (users
chaining `get_entity_related` because recall missed a connected fact). A LoCoMo
multi-hop score is benchmark performance on a synthetic eval with a deliberately
fixed answerer. It cannot, at ANY sample size, constitute usage evidence.

**Therefore the Wave 2 full-sample rerun does NOT reopen this.** It will make the
benchmark number statistically sounder; it cannot manufacture the kind of evidence
the bar asks for. Do not cite Wave 2 results as having cleared it.

Secondary: FEAT-481's rationale was TWO things — no demand signal AND "a consistent
taste for keeping retrieval's default blast radius small and opt-in." The latter is
a design preference, not an evidence gap, which raises the override bar further.

On benchmark terms it loses anyway: smallest headroom (+2), n=32, and the downside
is asymmetric — dilution would hit single-hop (2x the mass, already performing
better at 44.4 vs 35.4).

## Corrections the review forced (do not re-introduce)

- **WS3 is NOT an accidental gap.** `FEAT-481-design.md` §4.3 is titled "1-hop
  recall expansion: recommend OUT of v1" — a deliberate deferral. The
  "dilution risk" is verbatim their own rationale. Reopening requires making the
  case against the bar THEY set, not calling it unfinished work.
- **FEAT-485 is not LoCoMo-neutral.** Its scope item 2 (drop `lesson`/`decision`
  atoms lacking evidence) shrinks the atom pool — and atom count is the dominant
  score driver (0.24→0.45 tracked ~20x atoms/session). Sequence + re-measure it;
  do not wave it through.
- **"+7 pts" is a ceiling, not a target.** Only 3/37 temporal questions are true
  "how long ago"; ~1/3 of "when" gold answers are phrased relative to another
  date, which token-F1 penalizes even when the fact is right.
- Sample is **7.0%** (19/272 sessions), not 10%.
