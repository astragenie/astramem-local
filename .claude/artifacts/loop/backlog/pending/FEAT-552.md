---
id: FEAT-552
status: pending
priority: P1
category: feature
target_release: null
created: 2026-07-18
updated: 2026-07-18
depends_on: []
slices: []
derived_from: 2026-07-18 deterministic-hardening analysis — every item maps to a MEASURED failure from the 07-17/18 experiment series
cross_product: [astramem-local]
autonomous_safe: true
triage_notes: "Operator-directed (skip PM queue): file + run immediately as a 3-worktree wave. Zero new LLM dependencies; zero migrations (no schema changes → no number-collision risk). Each sub-scope cites the measured failure it kills."
---
## Description

**Deterministic hardening wave — parsers, regex, and prompt fixes for measured failure classes.**

Three bounded sub-scopes (one worktree each):

### A — extraction parsing hardening (src/distill/stages/05-extract.ts + prompts + parse util)
1. **JSON truncation salvage**: when extraction output fails Zod/JSON parse, attempt
   deterministic salvage — trim to the last complete atom object, close brackets,
   re-parse; on success keep the recovered atoms and log a structured
   `extract_salvage` event (count recovered/lost). Kills the maxTokens mid-JSON
   poison class (invalidated two eval legs; 3 identical retries then data loss).
   Salvage applies AFTER the normal retry path fails, never masks a healthy parse.
2. **Duplicate-key pre-parse detector**: scan raw JSON text for duplicated keys
   within one object before parsing (the last-key-wins atom-collapse class) — on
   detection, log loudly and treat as parse failure (feeding the retry/salvage
   path) rather than silently collapsing. Matters most for json_object-only
   providers (codex — our production default).
3. **passB evidence-compliance prompt fix**: sweeper prompt restructured so
   `evidence` is the FIRST required field, with a few-shot example carrying it and
   an explicit "atoms without a verbatim evidence quote are DISCARDED" warning.
   Measured basis: phi omitted the field 77% (165/191 gate drops), killing the
   gated-sweeper config. Success metric: gate drop-rate for no-evidence-field on a
   5-fixture mock bench run.

### B — regex type tier + retroactive backfill (new module + normalize-stage hook + CLI)
4. **Type-hint rules module** (`src/distill/type-hints.ts`): deterministic
   pattern tier applied at memory-normalize time — STRONG patterns only:
   leading shell-executable tokens (git|npm|bun|npx|kubectl|curl|docker...) →
   command; "chosen over|instead of|rather than|in favor of|decided to use|we will
   use" → decision; "turns out|root cause|the bug was|lesson:" → lesson;
   "shipped|released|deployed|merged" + past tense → event. The hint OVERRIDES the
   model's type only on conflict with a strong pattern; ambiguous → model type
   kept. Config `distill.typeHints: on|off` (default ON — deterministic, tested,
   reversible). Measured basis: decisions-filed-as-fact triggers are literally
   regexable ("X was chosen over Y"); typeAcc 43-63 across all models.
5. **`astramem-local backfill-types` CLI**: one-shot, operator-invoked re-typing of
   EXISTING stored atoms using the same rules module (dry-run mode prints the
   would-change census; apply mode updates memories.type + logs each change as a
   correction-style event for auditability). Fixes the "~1/3 of decisions invisible
   to type-filtered search" product defect retroactively with ZERO LLM calls.
   Batched updates, resumable, never touches text/embeddings (type is metadata —
   verified this week: hashes/vectors computed from normalizedText only).

### C — consolidation + evidence determinism (src/consolidate + src/distill/evidence-verify.ts)
6. **Command-token merge guard**: for candidate pairs where either atom is
   type=command, tokenize the command surface (executable, args, paths); if
   normalized token sets differ → the pair can NEVER auto-merge (neither via
   similarity threshold nor via a future judge verdict); log the guard hit.
   Measured basis (2026-07-18 prod audit): phi false-merged `git checkout A.ts` vs
   `B.ts` at confidence 1.00 — 3/3 sampled top-confidence merges were this class.
7. **Fuzzy evidence matching tier**: evidence-verify falls back from exact
   normalized substring to a token-window best-match (>=90% token overlap) before
   declaring evidence-not-found. Distinct drop reason (`evidence-fuzzy-matched`
   counts as PASS, logged) so the gate's integrity stays observable. Measured
   basis: 18 evidence-not-found drops in the 551 run include near-misses
   (whitespace/ellipsis variants).

## Explicitly out of scope
- No LLM calls added anywhere; no schema/wire changes; no migrations.
- No taxonomy changes (7 extraction types unchanged).
- The backfill CLI does not run automatically — operator-invoked only.

## Acceptance criteria (per sub-scope)
- A1: truncated-JSON fixture (cut mid-atom) recovers N-1 atoms with salvage log;
  healthy parse path byte-identical; retry still attempted before salvage.
- A2: duplicated-key fixture detected + loud log + treated as parse failure.
- A3: sweeper prompt updated; mock-provider test asserts evidence-first schema
  ordering survives; (live re-measure = follow-up, GPU lane).
- B1: rules module unit-tested against the 55-fixture gold set — measure hint
  accuracy on gold atoms (report %, target: strong patterns >=95% precision on the
  types they fire for; no-fire on ambiguous).
- B2: backfill dry-run on a seeded DB prints census; apply updates types + emits
  audit events; resumable; text/vec/hash untouched (asserted).
- C1: command-pair guard blocks merge in both the threshold path and the dup-judge
  resolve path; guard hit logged + counted; non-command pairs unaffected.
- C2: fuzzy tier passes near-miss fixtures, still rejects genuinely absent quotes;
  distinct reason codes asserted in DB rows.
- ALL: build + tsc(tests,eval) clean; full targeted suites green; DB-row
  assertions for every counter (house rule).
