---
id: FEAT-436
status: done
priority: null
category: platform
target_release: null
created: 2026-07-05
depends_on: [FEAT-409]
slices: []
derived_from: FEAT-409
tags: [concern:schema, concern:maintainability]
autonomous_safe: null
triage_notes: "Dispatched to re-parameterize the embed-dim 'six-file coordinated change' footgun CLAUDE.md flags under Do NOT. Audited all six named surfaces (schema/migration, config default, embed provider dim, contracts, boot-time preflight, reembed/vector code) in worktree wt-embeddim / branch feat/HARD-embed-dim-param and found the refactor already complete and merged under FEAT-409 (commits c5df2e5, fbf8436, 5b984f1; chore(backlog): FEAT-409 done). No functional change was made — reimplementing would have been redundant duplicate work. Only fix applied: CLAUDE.md's 'Do NOT' note was stale (still describing the parameterization as an open backlog item after it shipped), corrected in place with a pointer to FEAT-409 and this audit."
---

# FEAT-436: audit embed-dim single-source-of-truth (CLAUDE.md footgun re-check)

## Problem (as dispatched)

CLAUDE.md's `Do NOT` section warned that changing the embedding dimension
required a coordinated hand-edit across ~6 uncoordinated hardcoded sites
(schema/migration, config default, embed provider `dim`, contracts, the
v0.2.1 boot-time dim preflight, and reembed/vector code referencing the
literal 1024), and asked for a single source of truth so the other sites
derive from it, without changing the actual dim (must stay 1024) or forcing
existing DBs through a schema rewrite.

## Finding

This exact refactor already shipped and merged as **FEAT-409** ("Parameterize
embedding dimension", W4.9, done 2026-07-03, PR history: `5fbfc9e` /
`c5df2e5` feat commits, `fbf8436` review-fix commit, `b8e9baa`
"chore(backlog): FEAT-409 done"). Verified every site named in this FEAT's
dispatch is derived from one constant, not a fresh hardcode:

- **Single source of truth**: `DEFAULT_EMBED_DIM = 1024` in
  `src/contracts/embed.ts:26`, documented as the "ONE source of truth every
  coordinated surface derives from."
- **Schema/migration**: `migrations/001-init.sql` uses a `__EMBED_DIM__`
  placeholder in `memories_vec FLOAT[__EMBED_DIM__]`; `migrate()` in
  `src/storage/migrate.ts:29` substitutes the configured `dim` (default
  `DEFAULT_EMBED_DIM`) into any not-yet-applied migration file containing the
  token — a no-op for already-applied migrations, so it only affects genuinely
  fresh DBs.
- **Config default**: `src/config/config.ts` imports `DEFAULT_EMBED_DIM` and
  sets `embedding: { ..., dim: DEFAULT_EMBED_DIM }`.
- **Embed providers**: `OllamaEmbedProvider` (`src/providers/embed/ollama.ts:61`)
  and `AzureOpenAIEmbedProvider` (`src/providers/embed/azure-openai.ts:68`)
  both do `this.dim = config.dim ?? DEFAULT_EMBED_DIM`.
- **Vector store**: `SqliteVecStore` (`src/vector/sqlite-vec.ts:11`) takes
  `dim: number = DEFAULT_EMBED_DIM` and rejects vectors whose length doesn't
  match.
- **Boot-time preflight** (the v0.2.1-hotfix-class guard): `embed-probe.ts`
  defaults `expectedDim` to `provider.dim`; `migrate.ts`'s
  `getVecSchemaDim()` reads the dim actually baked into `memories_vec` from
  `sqlite_master` DDL (independent of whatever config currently says) so a
  drifted config/provider dim fails loud at boot instead of surfacing as a
  raw sqlite-vec error mid-ingest.
- **Mock/eval providers**: `src/pipeline/mock-providers.ts` and
  `src/search/search.ts`'s `makeFakeVec` both default to `DEFAULT_EMBED_DIM`.
- **Existing-DB path**: an existing DB's `memories_vec` dim is never
  rewritten by `migrate()` — it's baked in at `CREATE TABLE` time and
  immutable short of the resumable `astramem-local reembed-dim` command
  (migration 011, `docs/embed-dim-migration.md`), which is out of scope for
  a plain config-default change and was correctly not re-triggered here.

## Verification performed (no code change required for the refactor itself)

- `bun install` + `bun run build` clean.
- Full suite: **133 test files passed, 1338 tests passed, 4 skipped** (0 failed).
- `tests/eval/retrieval-eval.test.ts` (ADR-005 retrieval gate): 9/9 pass.
- `tests/doctor/probes/embed-probe.test.ts` (boot-time dim-mismatch guard,
  the v0.2.1 hotfix class this protects against): 11/11 pass.
- `tests/storage/upgrade-path.test.ts`: AC-1/AC-2 confirm a frozen schema-v12
  fixture DB migrates and searches with zero data loss and no vec-table
  rewrite; AC-3 confirms corrupt/half-migrated datadirs still fail loud.
- `tests/config/default-embed-dim-snapshot.test.ts` (FEAT-409 AC-6): pins
  every coordinated surface to the literal 1024 with no override configured —
  i.e. the byte-identical-default guarantee this FEAT's guardrails required
  is already a standing regression test, not just a one-time check.

## Action taken

- `CLAUDE.md`: replaced the stale "Do NOT change embed dim ... Six-file
  coordinated change. Backlog: parameterize." note (written before FEAT-409
  shipped) with an accurate description of the current single-source-of-truth
  design and a pointer to `reembed-dim` for the existing-DB case, plus a
  reference to this audit so the note doesn't silently go stale again.
- No source changes. The actual dim is unchanged (still 1024); no schema
  version bump; no existing-DB migration triggered.

## Recommendation

Close as a duplicate/no-op of FEAT-409 rather than re-running the
6-surface parameterization slice — it would be redundant work against
code that's already correct and covered by regression tests. If a genuine
non-default-dim deployment (e.g. swapping to a 768-dim model) is ever
needed, that's the `reembed-dim` runbook (`docs/embed-dim-migration.md`),
not a re-parameterization.

## Refs

- Origin: dispatch to re-verify CLAUDE.md's embed-dim "six-file coordinated
  change" footgun note.
- Prior work: FEAT-409 (`.claude/artifacts/loop/backlog/done/FEAT-409.md`),
  commits `5fbfc9e`, `c5df2e5`, `fbf8436`, `5b984f1`, `b8e9baa`.
- Worktree: `wt-embeddim`, branch `feat/HARD-embed-dim-param`.
