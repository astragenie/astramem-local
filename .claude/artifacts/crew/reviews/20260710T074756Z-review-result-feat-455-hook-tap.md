# Review Result — FEAT-455 hook-tap auto-capture

**Branch:** feat/feat-455-hook-tap (origin, pushed) · **Worktree:** C:\work\mega\astramemory-local-worktrees\feat-455-build
**Commits reviewed:** d5d0841 (build) + 5c7510b (merge main/453) + f23004b (fixup) + 717e1a2 (merge main/461-ticket)
**Effective diff:** `git diff origin/main...origin/feat/feat-455-hook-tap` — 32 files, +1197/-61
**Binding spec:** docs/adr/ADR-012-auto-capture-security-model.md (accepted 2026-07-10), docs/specs/FEAT-455-spike-results.md

## Verdict: PASS

Security-sensitive feature reviewed adversarially against all 5 ADR-012 decisions. No blocking findings. One pre-existing bug was self-discovered and correctly handled by the build (fixed for this feature's own field, deferred as FEAT-461 for the rest — see below).

## Checks performed

**1. Default-OFF invariant — HOLDS.** `defaultConfig()` (src/config/config.ts:363) sets `capture.autoCapture.enabled: false`. `init`'s non-interactive path (`gatherNonInteractive`) never touches the field; `promptAutoCaptureOptIn` returns `false` unconditionally when `nonInteractive` (src/cli/init.ts:657-665) and defaults the interactive confirm to `false`. No upgrade path, migration, or `writeConfig` call sets `enabled: true` anywhere in src/ — the only site that flips it to `true` is the explicit interactive wizard confirm (init.ts:785), and the only other write (`capture auto-capture disable`) only ever sets it to `false`. Grepped every `autoCapture.enabled` write site to confirm.

**2. AC-6 disjointness — HOLDS.** `src/capture/relevance-gate.ts` is a standalone module (own file header explicitly documents the AC-6 constraint), imports nothing from `durability-gate.ts`, and its 4 reasons (`too_short`/`too_large`/`duplicate_recent`/`structural_junk`) are purely structural (regex/length/byte-count/hash dedup) — no semantic taxonomy. `tests/capture/relevance-gate.test.ts:149-157` asserts disjointness by checking none of the 4 relevance reasons appear in the durability-gate's 5-value list — a real, meaningful assertion (not a tautology).

**3. Provenance correctness — HOLDS, no idempotency regression.** Traced envelope → transcripts row → distill → memories: `buildClaudeEnvelope`'s `capture_source` param is conditionally spread (`...(captureSource ? {...} : {})`), so a non-auto-capture envelope has no such key at all (not `capture_source: undefined`). `claudeIdempotencyKey` hashes `stableStringify(envelope minus captured_at)` — since the key is genuinely absent for every pre-455 call path, the hash is byte-identical to pre-455, confirmed by reading the diff directly. Same pattern server-side: `CanonicalIngestSchema.capture_source` is `.optional()`, defaults to `null` on insert (`data.capture_source ?? null`). This is **not** a blocking regression for in-flight spool replays across upgrade — verified, did not just take the ADR's word for it.
Provenance threads cleanly: `ingest.ts` → `transcripts.capture_source` → `distillHandler` (`TranscriptRow.capture_source` → `PipelineContext.captureSource`) → `08-embed-index.ts` (`EmbedIndexContext.captureSource` → `insertWithCreateEvent`'s `capture_source`). New tests in `tests/pipeline/handlers/distill.test.ts` prove both directions (auto_capture threads through; every other producer stays NULL).

**4. Migration 024 — HOLDS.** Two additive nullable columns (`transcripts.capture_source`, `memories.capture_source`) + one partial index, no table rewrite. `SCHEMA_VERSION = 24` consistent across `wire-meta.ts`, `migrate.ts`'s drift guard, and all version-number test assertions (version.test.ts, ingest-e2e.test.ts, atom-v3.test.ts, entities.test.ts, entity-validity.test.ts all bumped 23→24 correctly). Ladder coverage: `tests/storage/migrate.test.ts` runs the full 001-024 chain fresh; `tests/storage/upgrade-path.test.ts` (AC-1) migrates a real frozen v12 fixture through to v24 with zero-data-loss assertions — this is the strongest form of ladder coverage available and it's green.

**5. Purge scoping — HOLDS, failure handling is correct.** `runAutoCaptureDisable`'s query is `WHERE capture_source = 'auto_capture' AND valid_to IS NULL` — a manual-hook atom has `capture_source = NULL` and structurally cannot match (`NULL = 'auto_capture'` is never true in SQL). Per-id try/catch (src/cli/capture.ts:244-256): only HTTP 200 counts as erased, only 404 counts as already-gone; every other status (401/403/500/network error) increments `failed`. A systemic failure (e.g. every DELETE 401s) does **not** get folded into "success" — `failed > 0` sets `process.exitCode = 1` and prints an explicit retry message. Verified this exact case is test-covered (`tests/cli/capture-claude.test.ts:324`, "no daemon reachable: reports failures and non-zero exit, config stays disabled").

**6. Stage-0 redaction — HOLDS.** `redactText` is invoked once, at the `POST /ingest/transcript` choke point (src/server/routes/ingest.ts) — the same path spooled auto-capture envelopes flow through via the spool-drain worker (FEAT-449). No auto-capture-specific bypass exists. `tests/security/redact-autocapture.test.ts` is substantive, not a rubber stamp: it exercises burst/dedup, partial/truncated mid-stream turns, env-dump/connection-string shapes, and code-fence blobs against the real `redactText`, and **honestly documents 3 pre-existing gaps** (underscore-adjacent labels like `OPENAI_API_KEY=`, and one just-under-threshold entropy case) as `GAP:`-prefixed tests rather than hiding them — consistent with ADR-012's own framing that these are tracked separately as FEAT-459, not blockers for this slice.

**7. Merge quality — HOLDS.** `08-embed-index.ts`'s current state (read directly, lines 150-220) has both FEAT-453's entity-link-validity code (`linkWithValidity`, `valid_at`/`invalid_at` parsing) and FEAT-455's `captureSource` threading side by side — no dropped hunks from either parent. `f23004b` is a correctly-scoped one-purpose fixup: `tests/storage/entity-validity.test.ts` (a FEAT-453 file untouched by the merge's conflict set) had a stale `MAX(version) === 23` assertion that needed updating to 24 once both migrations 023 and 024 applied together; the commit message correctly explains why and touches only that one assertion.

**8. Full suite — HOLDS.** `bun run build` (tsc) clean. `bun run test`: **189 files / 2206 passed / 6 skipped / 0 failed** (skips pre-exist, not introduced by this branch). `bun run contracts:validate`: **52/52** fixture checks pass.

## Notable non-blocking observation

The build self-discovered that `src/config/writer.ts`'s `configToYaml()` was silently dropping several `Config` fields (`distill`, `ingest`, `memoryHealth`, `ingestIdempotency`) added after the emitter was last touched — including, initially, `capture` itself (which would have made the auto-capture opt-in and disable-purge flows silently no-op on every `writeConfig()` call). The build **fixed this for its own field** (writer.ts now emits the `capture`/`autoCapture` block, confirmed present in the diff and covered by `tests/cli/capture-claude.test.ts:274` asserting the disable path actually persists `enabled: false`), and correctly scoped the pre-existing bug for the *other* fields into a new backlog ticket (`FEAT-461`, priority unscored, flagged data-loss-shaped) rather than silently expanding this slice's surface area. No action needed from this review; flagging for triage awareness only.

## Minor nit (non-blocking)

`src/storage/memories.ts`'s `InsertInput.capture_source` doc comment still references `migrations/023-auto-capture-provenance.sql` — a stale filename from before the FEAT-453/455 merge renumbered this feature's migration to 024. Cosmetic only; does not affect behavior or the actual migration file (`migrations/024-capture-source.sql`), which is correctly named and referenced everywhere else.

## Recommendation

Safe to merge to main.
