/**
 * Add-on presence + version probe (FEAT-489 Slice A, packaging design pass
 * decisions 1-2). Lazy `await import('astramem-audio')` in a try/catch,
 * called only when `audio.mode !== 'off'` AND the transcribe handler or a
 * doctor check actually runs — never at module load / daemon boot. Mirrors
 * the existing shape `src/doctor/checks/sqlite-vec.ts` /
 * `src/doctor/checks/fts5.ts` already use for `better-sqlite3-multiple-ciphers`
 * / `sqlite-vec`.
 */
import type { AudioAddonModule } from './addon-contract.js';
import { SUPPORTED_ADDON_API_VERSIONS } from './addon-contract.js';

export type AddonProbeResult =
  | { status: 'absent'; error: unknown }
  | { status: 'version-mismatch'; installedVersion: number }
  | { status: 'ok'; module: AudioAddonModule };

/** Injection seam for tests — default performs the real dynamic import. */
export type AddonImporter = () => Promise<unknown>;

// `astramem-audio` is an OPTIONAL add-on, deliberately absent from this
// package's own dependencies (packaging design pass decision 1/2 — base
// install stays light, no workspace/peerDependency coupling). TypeScript
// only attempts module resolution for a dynamic `import()` whose specifier
// is a STRING LITERAL; routing it through this variable keeps the base
// package's typecheck green with zero add-on installed, same as the
// runtime behavior (a plain try/catch around a package that may not
// resolve at all).
const ADDON_SPECIFIER: string = 'astramem-audio';
const defaultImporter: AddonImporter = () => import(ADDON_SPECIFIER);

function looksLikeAddonModule(mod: unknown): mod is AudioAddonModule {
  if (typeof mod !== 'object' || mod === null) return false;
  const candidate = mod as Record<string, unknown>;
  return (
    typeof candidate.ASTRAMEM_AUDIO_ADDON_API_VERSION === 'number' &&
    typeof candidate.transcribe === 'function'
  );
}

/**
 * Probe for the optional `astramem-audio` add-on. Never throws — every
 * failure mode (package absent, malformed export, unsupported handshake
 * version) resolves to a discriminated result the caller renders as an
 * actionable message, never an unhandled crash (FEAT-489 acceptance hint).
 */
export async function probeAudioAddon(importer: AddonImporter = defaultImporter): Promise<AddonProbeResult> {
  let mod: unknown;
  try {
    mod = await importer();
  } catch (err) {
    return { status: 'absent', error: err };
  }

  // Support both `export default {...}` and a bare namespace export — an
  // add-on author following either ESM convention still probes correctly.
  const candidate = (mod as { default?: unknown })?.default ?? mod;

  if (!looksLikeAddonModule(candidate)) {
    return { status: 'absent', error: new Error('astramem-audio module present but missing expected exports') };
  }

  if (!SUPPORTED_ADDON_API_VERSIONS.has(candidate.ASTRAMEM_AUDIO_ADDON_API_VERSION)) {
    return { status: 'version-mismatch', installedVersion: candidate.ASTRAMEM_AUDIO_ADDON_API_VERSION };
  }

  return { status: 'ok', module: candidate };
}

/** Shared message strings so the doctor check and the pipeline handler
 *  report byte-identical text for the same failure mode. */
export function describeProbeFailure(result: Exclude<AddonProbeResult, { status: 'ok' }>, expectedVersion: number): string {
  if (result.status === 'absent') {
    return 'astramem-audio add-on not installed — run `npm install astramem-audio`';
  }
  return (
    `astramem-audio installed but API version ${result.installedVersion} unsupported ` +
    `(expected ${expectedVersion}) — reinstall a matching version`
  );
}
