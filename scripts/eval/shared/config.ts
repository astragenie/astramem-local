/**
 * Env/config resolution for the LongMemEval harness. Nothing here is ever
 * written to disk — the Azure key lives only in process.env for the
 * lifetime of the invoking process (team-lead instruction: never let it
 * land in a committable file).
 */
import { execFileSync } from 'node:child_process';

export interface AzureConfig {
  endpoint: string;
  apiVersion: string;
  answererDeployment: string;
  key: string;
}

const DEFAULT_AZURE_ENDPOINT = 'https://oai-astragenie-dev-cu-c4858.openai.azure.com';
// Verified live (2026-07-08): 2024-12-01-preview accepts reasoning_effort +
// max_completion_tokens against the gpt-5-mini deployment.
const DEFAULT_AZURE_API_VERSION = '2024-12-01-preview';
const DEFAULT_ANSWERER_DEPLOYMENT = 'gpt-5-mini';

const AZ_RESOURCE_GROUP = 'rg-astragenie-platform-dev-cu';
const AZ_ACCOUNT_NAME = 'oai-astragenie-dev-cu';
const AZ_SUBSCRIPTION = '12c8ba59-9321-4437-9138-3d899f077f23';

/**
 * Resolve the Azure OpenAI key: AZURE_OPENAI_KEY env var if already set,
 * otherwise a live `az cognitiveservices account keys list` call. Never
 * cached to disk — every invocation either reuses an inherited env var or
 * re-fetches (an az CLI round trip is ~1-2s, negligible next to the rest of
 * the run).
 */
export function resolveAzureKey(): string {
  const fromEnv = process.env.AZURE_OPENAI_KEY;
  if (fromEnv) return fromEnv;
  try {
    const out = execFileSync(
      'az',
      [
        'cognitiveservices', 'account', 'keys', 'list',
        '-g', AZ_RESOURCE_GROUP,
        '-n', AZ_ACCOUNT_NAME,
        '--subscription', AZ_SUBSCRIPTION,
        '--query', 'key1',
        '-o', 'tsv',
      ],
      { encoding: 'utf8' },
    ).trim();
    if (!out) throw new Error('empty key1 from az cli');
    return out;
  } catch (err) {
    throw new Error(
      `Could not resolve an Azure OpenAI key: set AZURE_OPENAI_KEY, or ensure ` +
      `\`az login\` is active and you have access to ${AZ_ACCOUNT_NAME}. ` +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function resolveAzureConfig(overrides: Partial<AzureConfig> = {}): AzureConfig {
  return {
    endpoint: overrides.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT ?? DEFAULT_AZURE_ENDPOINT,
    apiVersion: overrides.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? DEFAULT_AZURE_API_VERSION,
    answererDeployment: overrides.answererDeployment ?? process.env.AZURE_OPENAI_ANSWERER_DEPLOYMENT ?? DEFAULT_ANSWERER_DEPLOYMENT,
    key: overrides.key ?? resolveAzureKey(),
  };
}

export const AZ_ACCOUNT = { AZ_RESOURCE_GROUP, AZ_ACCOUNT_NAME, AZ_SUBSCRIPTION };
