/**
 * bearer-keystore.ts — bearer token resolution + one-way credential-store
 * migration (SEC-10, Wave 1 task 1d).
 *
 * Resolution order (used by serve.ts):
 *   1. CLI `--token` flag
 *   2. `ASTRA_MEMORY_TOKEN` env var
 *   3. OS credential store (service 'astramem-local', account 'bearer' —
 *      see storage/keystore.ts)
 *   4. secrets.env — canonical config dir, then legacy dir (kept as a
 *      read-only fallback; existing files are never deleted)
 *   5. 'devtok' default (dev/test convenience, matches pre-SEC-10 behavior)
 *
 * When the bearer is found only in secrets.env (step 4), it is
 * opportunistically promoted into the credential store — a one-way
 * migration, best-effort, and the secrets.env file itself is left
 * untouched (no destructive rewrite of a file that might also carry Azure
 * keys).
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { defaultConfigDir, legacyConfigDir } from '../config/datadir.js';
import { storeBearer, readBearer } from './keystore.js';

export type BearerSource = 'cli' | 'env' | 'credential-store' | 'secrets-env' | 'default';

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

  const stored = readBearer();
  if (stored) return { token: stored, source: 'credential-store' };

  const fileToken = readBearerFromSecretsFile(opts.secretsDirs);
  if (fileToken) {
    storeBearer(fileToken); // opportunistic one-way promotion; best-effort
    return { token: fileToken, source: 'secrets-env' };
  }

  return { token: DEFAULT_TOKEN, source: 'default' };
}
