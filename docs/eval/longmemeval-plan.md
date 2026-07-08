# LongMemEval evaluation plan for astramemory-local

Status: design only — no adapter code written yet. Dataset is on disk (see below).

## 1. What LongMemEval is

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025) benchmarks a chat
assistant's long-term memory: 500 hand-written questions, each paired with a synthetic
"haystack" of prior chat sessions the assistant must have absorbed before it can answer.
Three variants exist; we use **LongMemEval_S** — haystacks average ~40-50 sessions
(~115k tokens for a reference tokenizer), which is the standard "does this actually
work" tier before attempting the ~500-session `_M` variant.

Dataset is downloaded to `.eval-data/longmemeval/longmemeval_s_cleaned.json` (277MB,
`.gitignore`d — see §7 for the fetch command).

### 1.1 Verified schema (500 top-level entries, each one question)

```
question_id          string   e.g. "e47becba", or "<id>_abs" for the abstention variant
question_type        string   one of the 6 base types below
question             string   the query
question_date         string  "YYYY/MM/DD (Dow) HH:MM"
answer                string   gold answer
answer_session_ids    string[] evidence session id(s) — for session-level recall scoring
haystack_dates        string[] one per haystack session, same format as question_date
haystack_session_ids  string[] one per haystack session
haystack_sessions     array[]  one array-of-turns per session; each turn is
                                {"role": "user"|"assistant", "content": "..."}
                                (evidence turns are the ones cited by answer_session_ids;
                                 the file does not carry a literal has_answer key — the
                                 README's mention of it refers to the unpublished raw
                                 generation format, not this cleaned release)
```

### 1.2 Verified question-type breakdown (LongMemEval_S, n=500)

| question_type | count | of which `_abs` (abstention) |
|---|---|---|
| multi-session | 133 | — |
| temporal-reasoning | 133 | — |
| knowledge-update | 78 | — |
| single-session-user | 70 | 30 (all abstention questions are `_abs`-suffixed single-session-user) |
| single-session-assistant | 56 | — |
| single-session-preference | 30 | — |
| **total** | **500** | **30** |

Abstention is not a distinct `question_type` value in this release — it's a
`question_id` suffix (`_abs`) layered on `single-session-user`. The evaluator script
(§2) detects it by string-matching `_abs` in the id, not by `question_type`.

Average haystack size sampled across the first 20 questions: ~49 sessions,
~488k characters (~122k tokens at a 4-chars/token rule of thumb) — consistent with the
README's "~115k tokens (~40 sessions)" claim for a real tokenizer.

## 2. Official evaluation scripts

Not vendored into this repo (design phase only) — live at
`xiaowu0162/LongMemEval` under `src/evaluation/`. MIT licensed.

```
python3 evaluate_qa.py <judge_model> <hypothesis_file> <reference_file>
python3 print_qa_metrics.py <judge_model> <hypothesis_file>.log <reference_file>
```

- **Judge model**: hardcoded to whatever string you pass — the paper and nearly all
  published LongMemEval numbers use `gpt-4o`. Using a different judge makes results
  non-comparable to the leaderboard; if we ever want a cheaper eval loop we'd report
  both (see §6 cost note).
- **Hypothesis file**: JSON or JSONL, one record per question:
  `{"question_id": "...", "hypothesis": "<our system's generated answer text>"}`.
  `question_id` must carry the same `_abs` suffix as the reference file so the script
  picks the abstention judge prompt automatically.
- **Judge call**: OpenAI chat completion, `temperature=0`, `max_tokens=10`, single user
  message (no system prompt) with a question-type-specific template baked into the
  script (accepts equivalent phrasing, forgives off-by-one day errors on
  temporal-reasoning, allows superseded facts to co-occur with the update on
  knowledge-update, and for `single-session-preference` grades against a rubric that
  doesn't require every rubric point). Abstention questions get a different template
  asking whether the response correctly refuses.
- **Output**: `label = 'yes' in judge_reply.lower()`, written back as
  `hypothesis[i].autoeval_label = {model, label}`; `print_qa_metrics.py` aggregates to
  accuracy overall and per question_type.

We will call these scripts as an external step (subprocess or a thin Python venv),
not reimplement the judge prompts — reimplementing them would silently diverge from
the published methodology and make our numbers incomparable.

## 3. Adapter architecture (not yet built)

```
longmemeval_s_cleaned.json
        │
        ▼
┌───────────────────────┐
│ 1. Session loader     │  group question → its haystack_sessions[], preserving order
└───────────────────────┘
        │  per question, per session
        ▼
┌───────────────────────┐
│ 2. Ingest driver      │  POST /ingest/transcript  (canonical v1.0 envelope)
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ 3. Distill-wait gate  │  poll until async distillation has caught up
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ 4. Question driver    │  POST /recall  { text: question, limit: k, filters }
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ 5. Answer generator   │  fixed cheap LLM: recalled memories + question → hypothesis
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ 6. Official judge     │  evaluate_qa.py <judge> hyp.jsonl ref.json
└───────────────────────┘
```

### 3.1 Ingest mapping (per haystack session → one `/ingest/transcript` call)

Each `haystack_sessions[i]` becomes one canonical-envelope POST:

```json
{
  "event": "session_end",
  "session_id": "lme-<question_id>-<haystack_session_ids[i]>",
  "project_id": "longmemeval-<question_id>",
  "captured_at": "<haystack_dates[i] converted to ISO-8601 Z>",
  "turns": [ { "role": "user"|"assistant", "text": "<content>" }, ... ],
  "client_scrub_applied": false,
  "client_scrub_hits": 0,
  "client_version": "longmemeval-eval-harness/0.1",
  "client_scrub_version": "none",
  "wire_version": "v1.0"
}
```

Design decisions and why:

- **`project_id` = `longmemeval-<question_id>`, one per question, not one shared
  project.** Each question's haystack is an independent synthetic world — LongMemEval
  reuses raw ShareGPT-style sessions across different questions' haystacks (we saw
  `sharegpt_*` ids repeat), so if two questions shared a `project_id` their haystacks
  would pollute each other's recall pool. Isolating per-question is the only way to
  reproduce "the model only sees this question's haystack," which is the entire point
  of the benchmark. This means **500 independent logical tenants** for the S run.
- **`session_id`** is namespaced with the question_id prefix for the same reason, plus
  it keeps ingest idempotency keys (SHA-256 of body) from colliding across the run.
- **`captured_at`** carries the real haystack timestamp (parsed from
  `"YYYY/MM/DD (Dow) HH:MM"`), not ingest wall-clock time. This is load-bearing:
  temporal-reasoning and knowledge-update questions are *only* answerable if the
  daemon's bitemporal `valid_from`/`valid_to` tracking reflects the sessions' actual
  in-story dates. The existing `as_of` filter (`src/search/search.ts:183-202`,
  `parseAsOf`) already does exactly the bitemporal-snapshot job LongMemEval needs —
  no new daemon feature required, just correct `captured_at` plumbing at ingest time.
- Turns map `content` → `text` 1:1; no flattening needed on our side (the daemon's own
  `flattenTranscriptContent` pipeline stage handles turn→atom distillation internally).

### 3.2 Distill-wait strategy

Distillation is async (confirmed in CLAUDE.md: "distill is async — inherent"). The
harness cannot fire `/recall` immediately after the last ingest call for a question's
haystack; it must confirm distillation has drained first. Two options, in order of
preference:

1. **Poll `ingest_idempotency.summary_memory_id`** (or an equivalent per-session
   completion marker) for every session_id belonging to the question until all are
   populated, with a timeout + backoff. This is the documented backfill mechanism
   (CLAUDE.md "Formerly-deferred items" D-DEF2) and needs no new daemon endpoint.
2. Fallback: poll `GET /health` for a distill-queue-depth signal if one exists, or a
   fixed generous sleep (riskier — a fixed sleep either wastes time at scale or
   under-waits under load). Needs a repo check before relying on it; not assumed here.

Whichever mechanism, the harness should treat "haystack not fully distilled by
timeout" as a hard per-question failure, not a silent partial-answer — a partial
haystack would make the recall step invalid and corrupt the reported score.

### 3.3 Question phase

1. `POST /recall` (per `src/server/routes/search.ts:1-13`, canonical field names
   `text`/`limit`, legacy `query`/`k` accepted through the current release only — use
   canonical): `{ text: question.question, limit: k, filters: { project: "longmemeval-<question_id>" } }`.
   Filtering by `project_id` is what keeps 500 questions' recall pools from bleeding
   into each other on a single shared daemon instance (see §4 for why we don't want
   500 separate processes).
2. For temporal-reasoning / knowledge-update questions, additionally pass
   `filters.as_of = question_date` (converted to ISO-8601) so the recall reflects
   "what the assistant knew as of the question being asked," not "what's true now
   after every haystack session including ones dated after the question." This
   mirrors what a real deployed assistant would see and is the correct way to exercise
   the existing bitemporal filter end-to-end against a real benchmark rather than only
   the synthetic ADR-005 eval corpus (`src/eval/harness.ts`).
3. **Answering model**: fix one cheap, deterministic model (e.g. a small instruct
   model, temperature 0) across the whole run. The point of LongMemEval here is to
   measure the *memory system*, not the answering LLM — using a strong model would
   mask retrieval gaps by inferring answers from world knowledge or partial context;
   using a fixed cheap model makes score deltas attributable to recall changes (k,
   filters, ranking) between our own iterations. Do not use the same model as judge.
4. Hypothesis is written as `{"question_id", "hypothesis"}` JSONL, matching §2's
   contract exactly (including preserving the `_abs` suffix untouched from the
   reference file).

### 3.4 Scoring

Run the *unmodified* official scripts against our hypothesis file:
```
python3 evaluate_qa.py gpt-4o hyp.jsonl longmemeval_s_cleaned.json
python3 print_qa_metrics.py gpt-4o hyp.jsonl.log longmemeval_s_cleaned.json
```
Output: overall accuracy + per-question_type accuracy (including abstention as its own
row). We should archive the raw `.log` file per run under
`.eval-data/longmemeval/runs/<timestamp>/` (gitignored, same as the dataset) so score
regressions/improvements across our own iterations are diffable locally, plus a
one-line summary appended to a run-log doc for durability across sessions.

## 4. Throughput plan — ingestion is the bottleneck

500 questions × ~49 haystack sessions/question average ≈ **~24,500 `/ingest/transcript`
calls**, each triggering an async distill pass (LLM extraction stage per
`src/distill/prompts/extract.ts`). That's the dominant cost and the dominant wall-clock
time — recall (500 calls) and answer-generation (500 cheap-LLM calls) are comparatively
trivial.

Two levers, and we should use both:

1. **Batch ingestion within a question**: sessions belonging to one question can be
   posted concurrently (order doesn't causally depend on daemon acknowledgment, only
   the distill pipeline's own internal ordering/timestamp handling matters) — bounded
   by a concurrency limit per daemon instance to avoid saturating the local Ollama
   embed server, which is the actual shared resource across all "tenants."
2. **Parallel daemon instances, isolated by `ASTRA_MEMORY_DATADIR`**: since CLAUDE.md
   already documents `ASTRA_MEMORY_DATADIR=:memory:` for throwaway state, we can run
   N daemon processes on different ports, each with its own datadir, and shard the
   500 questions across them (round-robin by question_id). This avoids serializing
   the whole run through one SQLite file and one embed-probe queue. Real ceiling is
   local Ollama throughput (`mxbai-embed-large` embed calls), not daemon count — profile
   with 1 instance first, then scale instances until embed latency (not daemon CPU)
   is the limiter.

Rough estimate (numbers to validate empirically in the smoke phase, not assumed): if a
single ingest+distill round-trip is ~1-3s dominated by the embed call, ~24,500 calls
serialized is 7-20 hours; 8-way parallelism (8 datadirs) should bring a full S run
into the 1-3 hour range. The smoke test (§5 phase 1) exists specifically to replace
this estimate with a measured number before committing to a full run.

## 5. Phased runbook

1. **Subset-50 smoke test.** Sample 50 questions stratified across all 6 question
   types (roughly proportional to the §1.2 table, forcing at least a few `_abs`
   rows in). Single daemon instance, sequential ingestion. Goals: confirm the
   ingest→distill-wait→recall→answer→judge round trip works end-to-end, measure
   real per-question wall-clock and per-judge-call cost, catch schema mismatches
   early (e.g. date parsing edge cases in `question_date`/`haystack_dates`).
2. **Full LongMemEval_S run (500 questions).** Parallelized per §4. Produces the
   first real baseline: overall + per-type accuracy.
3. **Iteration levers**, each re-run against the *same* fixed haystack ingest (no
   need to re-ingest — only the question phase changes) to isolate what's improving:
   - `k` (recall `limit`) sweep — does more context help or just add noise for the
     fixed cheap answering model?
   - `filters` — with vs. without `project` isolation (sanity check that isolation
     is actually necessary — expected to matter a lot for multi-session/knowledge-update);
     entity filter engagement where applicable.
   - `as_of` — on vs. off for temporal-reasoning/knowledge-update specifically;
     expect a measurable accuracy gap since this is the exact bitemporal feature
     LongMemEval is designed to probe.
4. Only after a stable S baseline would `_M` (500-session haystacks) be worth
   attempting — it's a ~10x ingest volume increase and should not be started until
   the S throughput numbers from phase 2 are in hand.

## 6. Cost estimate

- **Judge (GPT-4o, 500 calls, max_tokens=10, ~200-400 input tokens/call including
  the question+answer+hypothesis+rubric text)**: order of $2-5 for a full S run at
  current GPT-4o pricing — cheap in absolute terms, but re-running it per iteration
  (§5 step 3) adds up over many sweep points; budget for ~10-20 judge runs during
  active iteration, not just one.
- **Answering model**: depends entirely on which fixed cheap model is chosen; this is
  the dial we control and should pick something priced low enough that many sweep
  iterations are inconsequential.
- **Local Ollama embed calls**: no API cost (local), but is the real throughput
  bottleneck per §4 — the cost that matters here is wall-clock, not dollars.
- Dominant real cost is engineering time building the adapter (§3) and the
  distill-wait polling logic (§3.2), not API spend.

## 7. Dataset fetch (already done for this session)

```powershell
mkdir .eval-data\longmemeval
curl -L -o .eval-data\longmemeval\longmemeval_s_cleaned.json `
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
```

Present at `.eval-data/longmemeval/longmemeval_s_cleaned.json` (277MB). `.eval-data/`
is now `.gitignore`d (added alongside the existing worktree-ignore block) — this file
should never be committed. If a fresh clone needs it again, re-run the command above;
no auth/token needed, it's a public HF dataset resolve URL.

Other variants (not downloaded, same base URL, swap filename) if `_M` or oracle-mode
work is ever undertaken:
- `longmemeval_m_cleaned.json` (~500 sessions/haystack)
- `longmemeval_oracle.json` (evidence-only sessions, no needle-in-haystack — useful as
  an upper-bound sanity check that the recall+answer+judge pipeline itself is correct
  before blaming the memory system for a low score)

## 8. Top risks

1. **Async distill-wait correctness is unverified.** We're relying on
   `ingest_idempotency.summary_memory_id` backfill (or an equivalent completion
   signal) to know when a haystack is fully searchable. If that signal is noisier or
   slower than assumed at ~24,500-call volume, the harness could race ahead and
   silently under-count recall, producing a deflated, wrong score rather than an
   obvious failure. Needs an explicit correctness check in the smoke phase, not just
   a throughput check.
2. **Per-question `project_id` isolation (500 tenants) is untested at this shape.**
   The daemon's multi-project filtering is exercised by existing tests at much
   smaller cardinality; whether it holds up cleanly at 500 concurrent/rapid-fire
   projects (indexing, filter performance, SQLite contention) is an open question the
   smoke test should surface before the full run commits to it.
3. **Judge/answerer model choice materially changes what's being measured, and it's
   easy to get subtly wrong.** Using GPT-4o as judge is required for comparability to
   published numbers, but if the fixed "cheap" answering model is too capable, it can
   answer several question types from general world knowledge or by pattern-matching
   the question rather than from actually recalled memory content — inflating the
   score independent of the memory system's quality. The answering model should be
   picked and its non-memory baseline (recall disabled) measured first as a control.
