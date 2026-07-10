/**
 * bearer-keystore.ts — bearer token resolution + one-way credential-store
 * migration (SEC-10, Wave 1 task 1d).
 *
 * Resolution order (used by serve.ts):
 *   1. CLI `--token` flag
 *   2. `ASTRA_MEMORY_TOKEN` env var
 *   3. OS credential store, identity scoped to configDir with a read-only
 *      fallback to the legacy unscoped identity (FEAT-466 — see
 *      storage/keystore.ts)
 *   4. secrets.env — canonical config dir, then legacy dir (kept as a
 *      read-only fallback; existing files are never deleted)
 *   5. 'devtok' default (dev/test convenience, matches pre-SEC-10 behavior)
 *
 * When the bearer is found only in secrets.env (step 4), it is
 * opportunistically promoted into the credential store — a one-way
 * migration, best-effort, and the secrets.env file itself is left
 * untouched (no destructive rewrite of a file that might also carry Azure
 * keys).
 *
 * ASTRA_MEMORY_ISOLATED=1 (same gate as config/resolve-runtime.ts): steps 3
 * and 4 above are skipped entirely — an isolated/eval daemon must never
 * read the real OS credential store or the real OS config dir's
 * secrets.env (identical hazard to the one resolve-runtime.ts closes for
 * config.yaml/sync.json: a caller that only redirects
 * ASTRA_MEMORY_DATADIR, not the OS config dirs, would otherwise pick up a
 * real bearer). Resolution collapses to CLI > env > a freshly generated
 * ephemeral token — never the shared 'devtok' default, which would let two
 * isolated daemons on the same box collide on the same bearer.
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { defaultConfigDir, legacyConfigDir } from '../config/datadir.js';
import { isIsolatedMode } from '../config/isolated-mode.js';
import { storeBearer, readBearer } from './keystore.js';

export type BearerSource = 'cli' | 'env' | 'credential-store' | 'secrets-env' | 'default' | 'ephemeral';

export interface ResolvedBearer {
  token: string;
  source: BearerSource;
}

export interface ResolveBearerOpts {
  /** Value of the CLI `--token` flag, if provided. */
  cliToken?: string;
  /** Value of `ASTRA_MEMORY_TOKEN`, if set. */
  envToken?: string;
  /**
   * Config dirs to probe for secrets.env, in priority order. Defaults to
   * [defaultConfigDir(), legacyConfigDir()]. Injectable so tests can isolate
   * the filesystem probe without env-var games — on darwin the real dirs
   * ignore XDG_CONFIG_HOME entirely, so env stubbing does NOT isolate there.
   */
  secretsDirs?: string[];
  /**
   * Config dir used to scope the OS credential-store identity (FEAT-466).
   * Defaults to defaultConfigDir(). Injectable for the same isolation
   * reason as secretsDirs — tests point this at a tmp dir so the stubbed
   * Entry's scoped key is deterministic and never collides with a real
   * install's identity.
   */
  configDir?: string;
}

const DEFAULT_TOKEN = 'devtok';

/**
 * Read MEMORY_BEARER from secrets.env — canonical config dir first, then the
 * legacy dir (%APPDATA%\AstraMemory on Windows). Read-only; never mutates
 * either file. Mirrors the pre-SEC-10 `readBearerFromSecrets` in serve.ts.
 */
export function readBearerFromSecretsFile(secretsDirs?: string[]): string | null {
  const dirs = (secretsDirs ?? [defaultConfigDir(), legacyConfigDir()]).filter(
    (d, i, arr) => arr.indexOf(d) === i, // deduplicate (non-Windows: same path)
  );

  for (const dir of dirs) {
    try {
      const path = join(dir, 'secrets.env');
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      const match = text.split('\n').find(l => l.startsWith('MEMORY_BEARER='));
      if (!match) continue;
      const bearer = match.slice('MEMORY_BEARER='.length).trim();
      if (bearer) return bearer;
    } catch {
      // continue to next candidate
    }
  }

  return null;
}

/**
 * Resolve the daemon's bearer token per the precedence documented above.
 *
 * Side effect: when the token is found only in secrets.env, it is
 * opportunistically written into the OS credential store (best-effort —
 * failure is silently tolerated since storeBearer already owns its own
 * WARN-on-fallback logging). This is a one-way promotion; secrets.env is
 * never rewritten or deleted here.
 */
export function resolveBearerToken(opts: ResolveBearerOpts = {}): ResolvedBearer {
  if (opts.cliToken) return { token: opts.cliToken, source: 'cli' };
  if (opts.envToken) return { token: opts.envToken, source: 'env' };

  if (isIsolatedMode()) {
    // Never touch the real OS credential store or the real OS config dir's
    // secrets.env under isolation — see the file-header note. No
    // `secretsDirs` override rescues this: isolation must hold even if a
    // caller forgot to pass one.
    return { token: randomBytes(32).toString('hex'), source: 'ephemeral' };
  }

  const configDir = opts.configDir ?? defaultConfigDir();

  const stored = readBearer(configDir);
  if (stored) return { token: stored, source: 'credential-store' };

  const fileToken = readBearerFromSecretsFile(opts.secretsDirs);
  if (fileToken) {
    storeBearer(fileToken, configDir); // opportunistic one-way promotion; best-effort
    return { token: fileToken, source: 'secrets-env' };
  }

  return { token: DEFAULT_TOKEN, source: 'default' };
}
