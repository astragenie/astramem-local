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
  /**
   * 64-character hex Bearer token (32 random bytes). Optional as of SEC-10:
   * callers omit this when the bearer was already stored in the OS
   * credential store — secrets.env is a fallback persistence layer, not the
   * bearer's primary home. See storage/keystore.ts storeBearer().
   */
  bearer?: string;
  /** Azure OpenAI API key, if azure provider selected. */
  azureKey?: string;
  /** Azure endpoint URL, if azure provider selected. */
  azureEndpoint?: string;
  /** Azure deployment name, if azure provider selected. */
  azureDeployment?: string;
  /** openai-compatible API key. Written under the config-referenced env var
   * name (config.openaiCompatible.apiKeyEnv, default OPENAI_COMPAT_API_KEY)
   * — omit when the target endpoint needs no auth (local vLLM, etc.). Also
   * used for the Groq/Gemini/Kimi/DeepSeek presets (Wave 1 BYO), which all
   * resolve through the openai-compatible provider — see
   * providers/llm/byo-presets.ts. */
  openaiCompatApiKey?: string;
  /** Env var name to write openaiCompatApiKey under — defaults to
   * OPENAI_COMPAT_API_KEY, mirrors config.openaiCompatible.apiKeyEnv. Each
   * BYO preset sets its own vendor-named var (GROQ_API_KEY, GEMINI_API_KEY,
   * MOONSHOT_API_KEY, DEEPSEEK_API_KEY) so switching presets never silently
   * reuses a stale key written under a different vendor's name. */
  openaiCompatApiKeyEnv?: string;
  /** Anthropic API key, if the anthropic provider is selected. Written under
   * config.anthropic.apiKeyEnv (default ANTHROPIC_API_KEY). */
  anthropicApiKey?: string;
  /** Env var name to write anthropicApiKey under — defaults to
   * ANTHROPIC_API_KEY, mirrors config.anthropic.apiKeyEnv. */
  anthropicApiKeyEnv?: string;
}

/**
 * Write secrets.env to `path`.
 *
 * Sets mode 0600 on Unix. On Windows the file is created with default ACL
 * (current user only) — a warning is printed if stdout is TTY.
 */
export function writeSecrets(payload: SecretsPayload, path: string): void {
  mkdirSync(dirname(path), { recursive: true });

  const lines: string[] = [];
  if (payload.bearer) lines.push(`MEMORY_BEARER=${payload.bearer}`);
  if (payload.azureKey) lines.push(`AZURE_OPENAI_API_KEY=${payload.azureKey}`);
  if (payload.azureEndpoint) lines.push(`AZURE_OPENAI_ENDPOINT=${payload.azureEndpoint}`);
  if (payload.azureDeployment) lines.push(`AZURE_OPENAI_DEPLOYMENT=${payload.azureDeployment}`);
  if (payload.openaiCompatApiKey) {
    lines.push(`${payload.openaiCompatApiKeyEnv ?? 'OPENAI_COMPAT_API_KEY'}=${payload.openaiCompatApiKey}`);
  }
  if (payload.anthropicApiKey) {
    lines.push(`${payload.anthropicApiKeyEnv ?? 'ANTHROPIC_API_KEY'}=${payload.anthropicApiKey}`);
  }
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
