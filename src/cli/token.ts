/**
 * token subcommand — `astramem-local token rotate`
 *
 * Generates a fresh 32-byte (64 hex char) random Bearer token, stores it in
 * the OS credential store (SEC-10), and prints the `export MEMORY_BEARER=...`
 * line so the user can paste it.
 *
 * secrets.env ALWAYS gets the new MEMORY_BEARER= line, regardless of
 * whether the OS-store write also succeeded (review fix-round decision,
 * FEAT-466: secrets.env is unconditionally authoritative for the bearer —
 * see storage/keystore.ts's bearer-section header for the rollback
 * rationale). rotateToken() also write-throughs the rotated token into the
 * LEGACY unscoped OS-credential-store identity (not just the new scoped
 * one) so a `reinstall --rollback` to a pre-FEAT-466 binary — which reads
 * only that legacy identity — picks up the current token instead of a
 * stale one.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecrets } from '../config/secrets.js';
import { defaultConfigDir } from '../config/datadir.js';
import { storeBearer } from '../storage/keystore.js';

/** Generate a cryptographically secure 32-byte hex token (64 chars). */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Rotate the Bearer token stored in secrets.env.
 *
 * Reads any existing secrets.env to preserve azure keys, then overwrites
 * with a freshly generated MEMORY_BEARER.
 *
 * @param secretsPath - Absolute path to secrets.env. Defaults to
 *   `defaultConfigDir()/secrets.env`.
 * @param configDir - Config dir used to scope the OS credential-store
 *   identity (FEAT-466). Defaults to `defaultConfigDir()`. Tests pass a tmp
 *   dir here to keep the stubbed Entry's scoped key isolated per test.
 * @returns The new Bearer token string (64 hex chars).
 */
export function rotateToken(secretsPath?: string, configDir?: string): string {
  const path = secretsPath ?? join(defaultConfigDir(), 'secrets.env');
  const dir = configDir ?? defaultConfigDir();
  const newToken = generateToken();

  // Preserve any existing azure keys from the current secrets.env.
  let azureKey: string | undefined;
  let azureEndpoint: string | undefined;
  let azureDeployment: string | undefined;

  if (existsSync(path)) {
    const content = readFileSync(path, 'utf8');
    for (const rawLine of content.split('\n')) {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith('AZURE_OPENAI_API_KEY=')) {
        azureKey = trimmed.slice('AZURE_OPENAI_API_KEY='.length);
      } else if (trimmed.startsWith('AZURE_OPENAI_ENDPOINT=')) {
        azureEndpoint = trimmed.slice('AZURE_OPENAI_ENDPOINT='.length);
      } else if (trimmed.startsWith('AZURE_OPENAI_DEPLOYMENT=')) {
        azureDeployment = trimmed.slice('AZURE_OPENAI_DEPLOYMENT='.length);
      }
    }
  }

  // SEC-10 + FEAT-466 review fix-round: store in the OS credential store
  // (scoped identity, with a write-through into the legacy identity so a
  // rollback to a pre-FEAT-466 binary doesn't resolve a stale bearer), AND
  // always write MEMORY_BEARER= into secrets.env regardless of whether the
  // OS-store write succeeded — secrets.env is unconditionally authoritative
  // for the bearer now. Azure keys (if any) are unaffected either way.
  storeBearer(newToken, dir, { writeThroughLegacy: true });
  writeSecrets(
    { bearer: newToken, azureKey, azureEndpoint, azureDeployment },
    path,
  );
  return newToken;
}

/** CLI entry for `astramem-local token <subcommand>`. */
export async function tokenCommand(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'rotate': {
      const token = rotateToken();
      console.log(`Token rotated. Add to your shell rc:\n`);
      console.log(`  export MEMORY_BEARER=${token}`);
      console.log('');
      console.log('The old token is now invalid. Restart the daemon to pick up the new token.');
      break;
    }
    default:
      console.error(`token: unknown subcommand '${sub ?? ''}'`);
      console.error('Usage: astramem-local token rotate');
      process.exit(1);
  }
}
