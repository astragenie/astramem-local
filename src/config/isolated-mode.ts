/**
 * isolated-mode.ts — shared ASTRA_MEMORY_ISOLATED=1 gate.
 *
 * Extracted from resolve-runtime.ts's local `isIsolated()` so any module
 * that must not touch the real OS config dir under eval/test isolation
 * (resolve-runtime.ts's config.yaml/sync.json merge, bearer-keystore.ts's
 * secrets.env/credential-store fallback) shares one definition rather than
 * re-deriving the env-var check.
 */
export function isIsolatedMode(): boolean {
  return process.env.ASTRA_MEMORY_ISOLATED === '1';
}
