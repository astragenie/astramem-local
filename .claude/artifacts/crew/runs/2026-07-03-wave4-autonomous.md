# Run brief — Wave 4 autonomous completion

**Started:** 2026-07-03 · **Owner:** lead (main thread) · **Mode:** autonomous, user away
**Authorization:** auto-merge all inspector-PASS features to main; drive all 9 FEATs to Wave 4 done; lead self-heals on builder FAIL.

## Scope

9 triaged FEATs (`.claude/artifacts/loop/backlog/triaged/FEAT-40[1-9].md`), Given/When/Then ACs hardened.
Builders: `crew:fullstack-dev` (code) / `crew:architect` (408 ADR). Review: `crew:inspector` per feature. Merge PASS → main.

## Wave plan (conflict-aware: search.ts + tests/eval serialize 401/402/404/409)

| Wave | Features | Builder | Notes |
|------|----------|---------|-------|
| 1 | 401, 403, 405, 406, 408 | fullstack-dev ×4 + architect(408) | disjoint files; 408 ADR unblocks 407 |
| 2 | 409, 407 | fullstack-dev ×2 | 407 needs 408 ADR merged first |
| 3 | 402-slice1 | fullstack-dev | distill extract + migration 009 + backfill |
| 4 | 402-slice2 | fullstack-dev | entity query surface + routes + CLI + eval |
| 5 | 404 | fullstack-dev | archival exclusion + cleanup handler |

Critical path: 401 → 409 → 402s1 → 402s2 → 404.

## Gate per feature

Builder must: implement all ACs + tests-per-AC; phase-gate green (`bun run build` tsc, `bun run test` vitest incl ADR-005 eval floors recall@10≥0.90/NDCG@10≥0.70, `node contracts/validate.mjs`); commit on `feat/w4-40X-<slug>`; NOT merge. Lead runs crew:inspector → PASS merge, FAIL self-heal (crew:fix / inline) → re-inspect → merge.

## Risk flags

- 406 security (auth boundary) — inspector must verify no public-endpoint gap.
- 409 six-file coordinated + re-embed migration — highest regression surface.
- 402 first schema migration since v0.6.0 (migration 009).
- 407 cross-service wire contract (SaaS repo absent locally) — validate buildable portion; hold if unverifiable AC-5/6.

## Progress log

- [x] Baseline committed `370ec82`
- [x] Wave 1 dispatched (401, 403, 405, 406 fullstack-dev; 408 architect)
- [x] **FEAT-408 PASS → merged `122a58c`** (ADR-011). 407 depends_on cleared.
- [x] **FEAT-405 PASS → merged** (poison purge). insp-405 re-verified gates + concurrency window.
- [x] **FEAT-406 PASS → merged** (remote /health auth). insp-406 security bypass hunt clean (0.0.0.0 fail-closed).
- [~] 401 as_of — builder hit limit mid-eval-verify, RESUMED for final gate report
- [~] 403 tag hygiene — builder hit limit before writing tests, RESUMED to finish tests+gates
- [x] Wave 2 early-start: **407 sync pull dispatched** (unblocked by 408; disjoint files). 409 held (collides 401 on search.ts).

- [x] **FEAT-403 PASS → merged** (tag hygiene, migration 009, SCHEMA_VERSION→9). insp-403 verified migration safety + version fallout.
- [x] **FEAT-401 PASS → merged** (as_of). insp-401 caught a REAL blocker (supersede insert→supersede overlap window returning both generations); builder fixed via transactional valid_from co-issue; re-verified fail→pass through real path. Stale contract comment corrected as follow-up.
- [~] FEAT-407 sync pull — builder hit limits twice, resumed; migration 010/SCHEMA_VERSION→10. Warned re valid_from-in-wire (dedup must key on event_id, not temporal cols).

**Merged to main: 5/9** (401, 403, 405, 406, 408). Main at SCHEMA_VERSION 9, builds clean after each merge.

## Revised tail plan (migration-serialized)

Remaining 402/404/407/409 all add schema migrations → migration numbers must stay contiguous, so their MERGES serialize (build can still overlap, but merge order fixes numbers):
- 407 → migration 010 / v10 (in flight)
- 409 → migration 011 / v11 (dispatch after 401 freed search.ts; hold until 407 merges to keep numbers contiguous)
- 402 s1+s2 → migration 012 / v12 (entities)
- 404 → migration 013 / v13 (archive flag)

Chose correctness (contiguous migrations on auto-merge-to-main) over maximum parallelism for the schema-heavy tail. Non-schema parts already parallelized in Wave 1.

- [x] **FEAT-407 PASS → merged `2a5612c`** (sync pull engine + migration 010, v10). insp-407 verified ADR-011 rules + ran a trial merge to hand over conflict resolution (incl a silent migrate.test COUNT trap). Reconciled: SCHEMA_VERSION 10, migrate COUNT→10, 401 supersede fix preserved. Full main-scoped suite 980 pass. **Live cloud pull = documented follow-up** (undefined /sync/pull contract).
- [~] FEAT-409 param embed dim — builder hit limit 3rd time (EXPECTED_DIM undefined mid-provider-refactor), resumed. migration 011/v11.

**Merged to main: 6/9** (401, 403, 405, 406, 407, 408). Main SCHEMA_VERSION 10.

### Operational notes
- Run suite from main with `bun run test -- --exclude '**/.claude/**'` — vitest otherwise scans nested agent worktrees (false failures from stale copies).
- Merged worktrees pruned; only 409's remains.
- Follow-ups logged: (1) cloud GET /sync/pull atom-body contract before live sync round-trip; (2) duplicate synthetic conflict_merge events across devices (audit noise, not corruption); (3) FEAT-403 partially-tagged idempotency test; (4) vitest config should exclude .claude/worktrees.

- [x] **FEAT-409 PASS → merged `c5df2e5`** (param embed dim + migration 011, v11). insp-409 FAIL (metadata-staleness blocker in reembed-dim + AC-3 schema-dim gap) → fresh fix-409 agent fixed both → re-verify PASS. Lead closed 409 inline after 5 builder limit-hits (substitution missing in 2 raw-migration test helpers). Reconciled COUNT→11. Main-scoped suite 1022 pass.

**Merged to main: 7/9** (401, 403, 405, 406, 407, 408, 409). Main SCHEMA_VERSION 11.

### Remaining (serial — search.ts/eval/migration collisions)
- [x] **FEAT-402 s1 PASS → merged** (entity extraction + migration 012/v12 + backfill). insp confirmed cascade (FK ON + supersede link-delete, zero orphans), normalize single-seam. Clean FF (agent caught + fixed a stale worktree base).
- [x] **FEAT-402 s2 PASS → merged** (entity query: filter pre-fusion intersect, /entities routes Bearer-gated, CLI, zeta=0 structural no-op, eval q9-q11). Eval 0.955/0.840. FEAT-402 COMPLETE.
- [~] FEAT-404 TTL/archival (mig 013/v13) — building (LAST feature)

**Merged to main: 8/9** (401,402,403,405,406,407,408,409). Main SCHEMA_VERSION 12. One feature left.

## ✅ WAVE 4 COMPLETE — 9/9 merged (2026-07-03)

All nine Wave-4 features merged to `main`. Phase-gate green ×2: **113 files, 1116 pass / 4 skip, 0 fail**; contracts 32/0; ADR-005 eval floors held throughout (final 0.955/0.840 ≥ 0.90/0.70). SCHEMA_VERSION **13** (migrations 001-013). All agent worktrees pruned.

| FEAT | What landed | Migration |
|------|-------------|-----------|
| 401 | as_of point-in-time search | — (fixed supersede overlap) |
| 402 | entity search (extraction + query surface, 2 slices) | 012 |
| 403 | repo/project tag hygiene backfill | 009 |
| 404 | memory TTL / archival tiers | 013 |
| 405 | queue purge --poison | — |
| 406 | remote /health auth boundary | — |
| 407 | sync bidirectional pull + ADR-011 conflict engine | 010 |
| 408 | ADR-011 multi-device conflict policy (design) | — |
| 409 | parameterized embedding dimension | 011 |

**New search modalities live:** temporal (as_of), entity-based (`search --entity`, /entities routes), archival-aware (archived excluded, restorable) — on top of existing keyword/semantic/fused/project-scoped.

### Inspector value (2 real blockers caught that builders' own tests masked)
- **401**: supersede insert→supersede overlap window returned BOTH generations for as_of queries — builder tests bypassed the real supersede() path. Fixed via transactional valid_from co-issue.
- **409**: reembed-dim never updated per-memory embedding metadata → columns permanently lied post-migration. + AC-3 preflight only checked provider self-consistency, not the persisted schema dim.
- Plus: 409 build closed inline by lead after 5 builder limit-hits (missing __EMBED_DIM__ substitution in 2 raw-migration test helpers); a Date.now() flake in 402-s2's zeta snapshot fixed deterministically; 404's migration-013 memory_events rewrite initially dropped event_id (407/ADR-011) — builder caught + fixed with explicit column list.

### Follow-ups (surfaced, NOT done — for user)
1. **[407]** Cloud `GET /sync/pull` atom-body contract undefined — live A→cloud→B round-trip needs the SaaS-side response shape defined first. Local merge engine is tested; httpPullFetcher unexercised. `atom_snapshot` is a local assumption.
2. **[402-s2]** `contracts/schemas/retrieval-query.v1.schema.json` lacks `entity` in filters — cross-repo contract change if SaaS needs entity filtering.
3. **[409]** doctor/providers CLI don't do the schema-dim parity check (only daemon boot does).
4. **[407]** Duplicate synthetic conflict_merge events across devices (audit noise, converges correctly).
5. **[403]** partially-tagged idempotency test not literally exercised (behavior correct).
6. **[402-s1]** misleading test description in 05-extract.test.ts.
7. Infra: vitest config should exclude `.claude/worktrees` (nested worktrees inflate `bun run test` from main — use `--exclude '**/.claude/**'` meanwhile).

### On completion of 404
- Run `bun run test -- --exclude '**/.claude/**'` on main (full phase-gate).
- Write final synthesis. Wave 4 = done.
- Follow-ups for user: (1) cloud /sync/pull atom-body contract [407]; (2) retrieval-query.v1 schema `entity` filter for SaaS parity [402-s2]; (3) doctor/providers CLI dim-parity [409]; (4) vitest config exclude .claude/worktrees; (5) 05-extract test-name nit [402-s1]; (6) duplicate synthetic conflict_merge events [407]; (7) 403 partially-tagged idempotency test.

### Pattern observed
Big features (401,403,407,409, now 402) hit turn/token limits mid-build and need 1-5 resumes; smaller ones (405,406,408) one-shot. Inspectors caught 2 real blockers the builders' own tests masked (401 supersede overlap, 409 reembed metadata staleness) — the adversarial gate is earning its cost.
