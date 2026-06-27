/**
 * writeSecrets — write secrets.env to disk with mode 0600 (Unix).
 *
 * Format is shell-sourceable: KEY=value lines.
 * On Windows, chmod is a no-op (NTFS uses ACLs; warn user instead).
 */

import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { platform } from 'node:os';

export interface SecretsPayload {
  /** 64-character hex Bearer token (32 random bytes). */
  bearer: string;
  /** Azure OpenAI API key, if azure provider selected. */
  azureKey?: string;
  /** Azure endpoint URL, if azure provider selected. */
  azureEndpoint?: string;
  /** Azure deployment name, if azure provider selected. */
  azureDeployment?: string;
}

/**
 * Write secrets.env to `path`.
 *
 * Sets mode 0600 on Unix. On Windows the file is created with default ACL
 * (current user only) — a warning is printed if stdout is TTY.
 */
export function writeSecrets(payload: SecretsPayload, path: string): void {
  mkdirSync(dirname(path), { recursive: true });

  const lines: string[] = [`MEMORY_BEARER=${payload.bearer}`];
  if (payload.azureKey) lines.push(`AZURE_OPENAI_API_KEY=${payload.azureKey}`);
  if (payload.azureEndpoint) lines.push(`AZURE_OPENAI_ENDPOINT=${payload.azureEndpoint}`);
  if (payload.azureDeployment) lines.push(`AZURE_OPENAI_DEPLOYMENT=${payload.azureDeployment}`);
  lines.push(''); // trailing newline

  writeFileSync(path, lines.join('\n'), { encoding: 'utf8' });

  if (platform() !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Rare on normal FS; ignore — caller should warn.
    }
  }
}
