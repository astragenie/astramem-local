/**
 * token subcommand — `astramem-local token rotate`
 *
 * Generates a fresh 32-byte (64 hex char) random Bearer token, stores it in
 * the OS credential store (SEC-10), and prints the `export MEMORY_BEARER=...`
 * line so the user can paste it. secrets.env is written ONLY as a fallback
 * when the credential store is unavailable (mode 0600 on Unix) — mirrors the
 * db-key degradation pattern in storage/keystore.ts.
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
 * @returns The new Bearer token string (64 hex chars).
 */
export function rotateToken(secretsPath?: string): string {
  const path = secretsPath ?? join(defaultConfigDir(), 'secrets.env');
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

  // SEC-10: try the OS credential store first; only fall back to writing the
  // bearer into secrets.env when the store is unavailable. Azure keys (if
  // any) are unaffected — they still live in secrets.env regardless.
  const { stored } = storeBearer(newToken);
  writeSecrets(
    { bearer: stored ? undefined : newToken, azureKey, azureEndpoint, azureDeployment },
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
