---
status: PASS
---
# Validation Result: as_of population-side fix (captured_at -> valid_from) re-verified live on v0.10.0

- Created: 2026-07-09T23:42:00Z
- Validator: verifier
- Environment: isolated throwaway daemon (never the production 7777 instance) — `node dist/cli/index.js serve --port 7799` spawned with `APPDATA`/`LOCALAPPDATA`/`HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME` redirected into a fresh `mkdtempSync` sandbox (same technique as `scripts/eval/longmemeval/lib/spawn-daemon.ts`'s `makeIsolatedEvalEnv` — a fresh config dir has no `sync.json`, so sync stays disabled by default; no prod tenant pairing possible). Package version served: 0.10.0. Ollama localhost:11434, extraction model `qwen2.5-coder:7b`, embedding `mxbai-embed-large` (1024-dim).
- Decision: passed
- Status: PASS — **FIX CONFIRMED**
- Scenario: Re-ran the as_of bisection from `scripts/eval/longmemeval/README.md:357-420` against a current build to confirm the population-side fix (`src/pipeline/handlers/distill.ts:108-113`, envelope `captured_at` -> `memories.valid_from`) works end-to-end. The original bisection (2026-07-08) ran on a pre-fix binary that had not been rebuilt after the fix commit landed.

## Method
1. Ingested one canonical v1.0 envelope (`POST /ingest/transcript`, Bearer auth) with `captured_at: "2023-09-15T12:00:00Z"` and a distinctive synthetic fact ("pet ferret named Zephyrine-Quaddle, purple enclosure").
2. Polled `GET /sessions/:id/digest` until `status: "ready"` (3 fact atoms extracted and embedded).
3. Bisected `POST /recall` (`{text, limit, filters: {as_of}}`) for the fact across four `as_of` values.

## Bisection table

| `as_of` value | hit_count | fact found |
|---|---|---|
| (none) | 3 | yes |
| `2023-12-01` (after `captured_at`, before today — the case that returned **0** pre-fix) | **3** | **yes** |
| `2020-01-01` (before `captured_at`) | 0 | no |
| `2027-07-09` (future) | 3 | yes |

All four outcomes match the expected bitemporal-correct behavior: the cutover point is now the session's `captured_at` (2023-09-15), not real ingestion wall-clock time (2026-07-09) as it was pre-fix. The previously-broken case — `as_of` set after `captured_at` but before the real ingest date — now correctly returns hits instead of 0.

## Notes / gotchas hit during verification
- First two attempts used `ASTRA_MEMORY_ISOLATED=1` in addition to the directory-redirection sandbox, which caused `resolveRuntimeConfig` (`src/config/resolve-runtime.ts:69-75`) to skip `config.yaml` entirely and fall back to `defaultConfig()`'s extraction model (`qwen2.5:7b`, not `qwen2.5-coder:7b`) — that model returned empty extraction (0 atoms) for this transcript, a test-harness setup gap, not a daemon bug. Fixed by dropping `ASTRA_MEMORY_ISOLATED` and relying solely on directory redirection + writing a `config.yaml` with the production `qwen2.5-coder:7b` extraction/compaction models into the sandboxed config dir — this matches exactly what `scripts/eval/longmemeval/lib/spawn-daemon.ts`'s `makeIsolatedEvalEnv` does (it does not set `ASTRA_MEMORY_ISOLATED` either).
- Isolated daemon killed (SIGTERM) and sandbox temp dir removed at end of run; production daemon on port 7777 was never touched.

## Follow-up
`scripts/eval/longmemeval/README.md`'s "RESOLVED (historical)" section (`README.md:357-372`) can now drop its "re-verify the bisection table once against a freshly-reinstalled >=0.10.0 daemon before publishing a temporal score" caveat — that re-verification is this artifact.

- Evidence Collected: full daemon stdout/stderr transcript (ingest, distill stages, 4x /recall responses) captured in the verification run; raw result also written to `.claude/artifacts/crew/validations/_asof-verify-result.json`.
- Files / Surfaces Checked: `src/pipeline/handlers/distill.ts:108-113`, `src/server/routes/search.ts` (`POST /recall` `filters.as_of`), `src/config/resolve-runtime.ts` (isolation gotcha).
- Risks: none identified for this fix. Legacy v0.0 envelopes (no `captured_at`) still fall back to wall-clock by design, unchanged.
- Required Follow-up: update `scripts/eval/longmemeval/README.md`'s re-verify caveat per the note above (doc-only, not done as part of this validation).
