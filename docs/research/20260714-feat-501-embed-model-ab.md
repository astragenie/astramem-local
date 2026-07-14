# FEAT-501 stage 1: bge-m3 vs mxbai-embed-large retrieval A/B

Status: **EXPERIMENT COMPLETE, stage 1 only.** No shipped default changed. No
production config/data touched (`%APPDATA%\Astramem`, `%LOCALAPPDATA%\AstraMemory`
untouched throughout). Branch: `worktree-agent-a5202001902e2ffc8`.

## 1. Query-prefix determination (architect's binding precondition)

**bge-m3 needs no query-side instruction prefix** — unlike `mxbai-embed-large`
(which is measured +17.5 MRR from `'Represent this sentence for searching
relevant passages: '`), bge-m3 dense retrieval takes queries and passages
identically, with no prompt on either side.

Source: HuggingFace `BAAI/bge-m3` model card FAQ (fetched 2026-07-14):
> "The only difference is that the BGE-M3 model no longer requires adding
> instructions to the queries" (comparing bge-m3 to earlier BGE models, which
> DO require `'Represent this sentence for searching relevant passages: '`).

Cross-checked against `bge-model.com`'s BGE-M3 usage docs, which describe dense
retrieval as "the normalized hidden state of the special token [CLS]" with no
mention of an instruction prefix for either queries or passages.

Action taken: added an explicit `'bge-m3': ''` entry to `QUERY_PREFIX_BY_MODEL`
(`src/contracts/embed.ts`) rather than relying on the map's default fallback for
unlisted models — makes the determination auditable, not indistinguishable from
"nobody checked." Functionally a no-op (`resolveEmbedQueryPrefix` already
returns `''` for unlisted models); this just documents the decision at the
symbol.

## 2. bge-m3 availability + dims

`ollama pull bge-m3` — succeeded (blob ~1.2GB). Live embed probe against
`http://127.0.0.1:11434/api/embeddings`:

```
model=bge-m3 -> embedding length = 1024
```

**Confirmed: 1024-dim, matches `DEFAULT_EMBED_DIM`.** The FEAT's same-dim premise
("no schema migration needed") holds — verified live, not assumed from the
model card.

## 3. License

**MIT**, per the `BAAI/bge-m3` HuggingFace model card tags (fetched 2026-07-14).
Matches the FEAT's expectation; blocking checkbox cleared.

## 4. Retrieval A/B — what ran and why

### What I could NOT run: full LoCoMo-corpus real-embedding A/B

The plan was to re-embed an already-extracted LoCoMo corpus (holding
extraction constant, only varying the embedding model) and score recall
against the real QA gold answers. Two locally cached LoCoMo runs exist under
`.eval-data/locomo/runs/`:

- `2026-07-12T23-49-26-531Z/`: `run-manifest.json` shows `ingest_ok: 0,
  ingest_failed: 272, distill_timed_out: 10` (all 10 conversations timed out).
  Its `datadir/memory.sqlite` has only 46 memory rows across 4 conversations —
  partial/interrupted residue from the failed run, not a complete extraction.
- `20260713-postfix-10pct/`: 0 memory rows.

Neither is a usable "extraction held constant" snapshot. Running a **fresh**
full LoCoMo ingest+distill to get one is exactly the multi-hour, real-daemon-
spawn operation `scripts/eval/locomo/README.md` and this repo's CLAUDE.md
explicitly warn against running from a coding-agent shell tool (verified
2026-07-08 incident: a coding-agent sandbox silently reaped a spawned daemon
mid-run). That operation is **out of scope for this stage-1 same-day pass** —
flagged as the concrete follow-up below, not attempted here.

### What I DID run: real-embedding A/B on the ADR-005 harness (as literally named by the FEAT)

Built `scripts/eval/feat-501-embed-model-ab.mts` — an in-process script (no
daemon spawn, no HTTP; a `:memory:` DB + direct library calls, the same
pattern `tests/eval/retrieval-eval.test.ts` uses) that runs
`runRetrievalEval` (`src/eval/harness.ts`, the exact ADR-005 harness the FEAT
names) against `contracts/fixtures/eval/corpus.json`/`queries.json` (12 atoms,
11 graded queries) with a **real** `OllamaEmbedProvider` substituted for the
deterministic fake embedder — once for `mxbai-embed-large` (with its shipped
query prefix), once for `bge-m3` (no prefix, per §1). Two weight profiles per
model: production-default fusion weights (`alpha=0.4 beta=0.4 gamma=0.1
delta=0.1 epsilon=0.1`) and a vector-only profile (`beta=1`, everything else
0) to isolate pure embedding-space quality from the FTS5/BM25 contribution.

### Results

| model | weights | recall@10 | NDCG@10 |
|---|---|---|---|
| mxbai-embed-large | production-default | 0.9545 | 0.9925 |
| bge-m3 | production-default | 0.9545 | 0.9925 |
| mxbai-embed-large | vector-only | 0.9545 | 0.9925 |
| bge-m3 | vector-only | 0.9545 | 0.9925 |

**Byte-identical across both models and both weight profiles** (q2's 0.5
recall/0.917 NDCG is by design — its grade-1 atom is invalidated, correctly
excluded — same as the fake-embedder baseline in
`tests/eval/retrieval-eval.test.ts`). Full per-query breakdown + raw JSON:
`scripts/eval/results/feat-501-embed-model-ab.json`.

### Verdict on this measurement: inconclusive, not "flat = falsified"

The ADR-005 fixture is a small (12-atom), deliberately-unambiguous **CI
regression-gate** corpus — every query's correct atom is a clear winner
regardless of embedding geometry, which is why it stays saturated even under
`vector-only` weights that remove FTS5's contribution entirely. Both models
ace it. This is a genuine result (proves neither model regresses retrieval
on the existing CI gate — useful on its own), but it cannot distinguish two
competent embedding models from each other; the fixture has no discriminating
power at this scale. **This does NOT settle the FEAT's core question** (does
bge-m3 improve real conversational-memory retrieval over mxbai) — it only
confirms real bge-m3 embeddings don't regress the existing regression floor.

## 5. Recommendation

**Do not close FEAT-501 as falsified, and do not flip the default.** The stage-1
question (does bge-m3 beat mxbai on retrieval quality) is genuinely
unanswered — not because the models tied, but because the only fixture I could
safely run in this dispatch (in-process, no daemon spawn) is saturated for
both. The two cached LoCoMo extraction snapshots that would have let me
measure this without a fresh multi-hour ingest are both broken (see §4).

Concrete next step for stage 1 completion (a distinct follow-up dispatch, run
from a plain terminal per the daemon-spawn warning, not from an agent shell):
run a fresh, successful LoCoMo ingest+distill pass once (extraction fixed
across both arms), then re-embed that one corpus with each model using the
same in-process-harness technique this script demonstrates (swap
`OllamaEmbedProvider`, keep everything else fixed) and score with
`diagnose-retrieval.mts`'s not-in-db/rank-miss/rank-ok classification (or the
recall@10/NDCG@10 derivation from it) against the real QA gold answers. That
is the measurement that actually answers the FEAT's question; this stage-1
pass only cleared the two binding preconditions (query-prefix, dim) and
proved the harness-swap technique works end-to-end with real Ollama
embeddings.

## Artifacts

- `scripts/eval/feat-501-embed-model-ab.mts` — the A/B script (reusable for
  the follow-up).
- `scripts/eval/results/feat-501-embed-model-ab.json` — raw results.
- `src/contracts/embed.ts` — added `'bge-m3': ''` to `QUERY_PREFIX_BY_MODEL`
  (documentation-only; `resolveEmbedQueryPrefix` behavior is unchanged for
  unlisted models, this just makes the determination explicit and auditable).
