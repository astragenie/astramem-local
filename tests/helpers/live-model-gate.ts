/**
 * Shared permission gate for LIVE-model tests (issue #251).
 *
 * The hazard: several suites fired real Ollama calls gated only on
 * *reachability* ("is Ollama up?" via a /api/tags ping) — a CAPABILITY
 * check standing in for a PERMISSION check. On a box where Ollama happens
 * to be running (any developer machine, or this repo's own daemon host),
 * the documented, CI-parity `bun run test` command silently fired live
 * ~2.4-2.9s model calls into a possibly-already-saturated GPU. See #251.
 *
 * The fix is permission-first, reachability-second:
 *   1. `INTEGRATION_LIVE` must be explicitly set — the opt-in every other
 *      live-provider suite in this repo already uses (ollama-llm.test.ts,
 *      ollama-embed.test.ts, azure-llm.test.ts, azure-embed.test.ts,
 *      codex-subscription-llm.test.ts, openai-compatible-llm.test.ts).
 *   2. `ASTRA_MEMORY_MOCK_PROVIDERS=1` — the flag every doc and every wave
 *      plan tells operators to set to keep tests off a live model — always
 *      wins and forces a skip, even if `INTEGRATION_LIVE` was also set.
 *   3. Reachability (a live /api/tags ping, or equivalent) stays a
 *      SECONDARY check made *inside* the still-gated test/describe block,
 *      never a substitute for permission.
 *
 * Default (both env vars unset, the plain documented `bun run test`
 * command): tests gated by this constant make ZERO calls to a live model
 * host, deterministically, regardless of what happens to be running on the
 * box.
 */
export const LIVE_MODEL_TESTS_DISABLED =
  !process.env.INTEGRATION_LIVE || process.env.ASTRA_MEMORY_MOCK_PROVIDERS === '1';
