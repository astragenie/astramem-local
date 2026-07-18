---
findings: "🔴:0,🟡:1,❓:0"
status: completed
decision: rejected
author_id: crew:fullstack-dev
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-18T07:48:17.129Z
- Reviewer: reviewer
- Decision: rejected
- Status: completed
- Summary: needs_fix: AC-B1's measured 100% command-hint precision does not hold in production - the census tests getTypeHint() against raw fixture text while both real call sites feed it entity-dict-canonicalized text, and ENTITY_DICT capitalizes bare 'bun' to 'Bun', silently defeating the case-sensitive command regex for every bun-led command atom (live-reproduced against dist/); isolated low-risk fix + regression test required before merge.
- Evidence Checked:
  - Live repro: node against dist/distill/stages/07-memory-normalize.js shows normalizeText('bun run test')==='Bun run test' and memoryNormalize(...) returns typeHintApplied:undefined (hint never fires). 3 of the 10 command-fires the AC-B1 census (tests/distill/type-hints.test.ts:139
  - calls getTypeHint(atom.text) on RAW text) counts as correct are 'bun run ...' fixtures (fx12-command-heavy.json:17-19) that would NOT be corrected by the real pipeline (07-memory-normalize.ts:112-119
  - backfill-types.ts:124 both call getTypeHint on normalized_text). Independently re-ran targeted suites: 5 files/164 tests green; tsc -p tsconfig.tests.json --noEmit clean. Confirmed by grep: usefulness.ts negative-signal queries all filter literal family='memory_corrected'
  - so backfill's 'type_corrected' family is genuinely excluded. Confirmed both getTypeHint call sites and both config governance composition points (loadConfig + loadConfigFromDisk) are genuinely wired
  - not orphaned.
- Files Reviewed:
  - src/distill/type-hints.ts
  - src/distill/stages/07-memory-normalize.ts
  - src/distill/pipeline.ts
  - src/pipeline/handlers/distill-events.ts
  - src/config/config.ts
  - src/config/loader.ts
  - src/config/writer.ts
  - src/distill/backfill-types.ts
  - src/cli/backfill-types.ts
  - src/cli/index.ts
  - tests/distill/type-hints.test.ts
  - tests/distill/07-memory-normalize.test.ts
  - tests/storage/backfill-types.test.ts
  - tests/config/config.test.ts
  - tests/config/writer.test.ts
- Test Adequacy: 164 targeted tests across 5 files independently re-run and green; strong coverage for override semantics/governance/backfill batching-resume-idempotency with real DB + real memories_vec row assertions; gap: no test seeds a bun-led command atom through the real memoryNormalize/runTypeBackfillBatch entry points, which is exactly what let the HIGH finding ship green.
- Author: crew:fullstack-dev
- Judge: crew:reviewer
- Risks: HIGH (tracked as the sole blocking finding, not counted in the 🟡/🔴 tally above which uses this CLI's severity buckets loosely): command type-hint silently never fires for any 'bun'-led command atom in both live distill and backfill-types CLI, because ENTITY_DICT capitalizes 'bun'->'Bun' before the case-sensitive COMMAND_LEAD_RE runs; falsifies the AC-B1 census's claimed 100% command precision for the shipped code path. MEDIUM: backfill-types.ts checkpoint write (writeCheckpoint, line 59) is non-atomic (plain writeFileSync, not tmp+rename like writeConfig()) - self-healing via malformed-JSON-to-rowid-0 fallback but could force a full-corpus rescan after a crash-during-write on a large (48k-row) backfill.
- Required Follow-up: Fix the bun/ENTITY_DICT vs COMMAND_LEAD_RE case-order bug (reorder hint-check before entity-dict canonicalization, or make the command check case-insensitive with verification against false-positive risk on capitalized narrative openers), add a regression test that seeds a bun-led command atom through memoryNormalize() end-to-end (not raw getTypeHint()), and correct or caveat the AC-B1 census methodology so it reflects the real normalizeText-then-getTypeHint production order. Optional follow-up (non-blocking): make backfill-types.ts's checkpoint write atomic (tmp+rename) to match writeConfig()'s established pattern.

