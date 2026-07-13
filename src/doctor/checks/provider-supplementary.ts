import type { Check, CheckResult } from '../types.js';
import { openAICompatibleReachabilityProbe } from '../probes/openai-compatible-probe.js';
import { codexAuthProbe } from '../probes/codex-subscription-probe.js';
import { OpenAICompatibleLLMProvider } from '../../providers/llm/openai-compatible.js';
import { CodexSubscriptionLLMProvider } from '../../providers/llm/codex-subscription.js';

// ─── Check: openai-compatible reachability / codex-subscription auth ────────

export function checkOpenAICompatibleReachable(provider: OpenAICompatibleLLMProvider, label: string): Check {
  return {
    name: `OpenAI-compatible reachability (${label})`,
    async run(): Promise<CheckResult> {
      return openAICompatibleReachabilityProbe(provider.baseUrl);
    },
  };
}

export function checkCodexAuth(provider: CodexSubscriptionLLMProvider, label: string): Check {
  return {
    name: `Codex auth (${label})`,
    async run(): Promise<CheckResult> {
      return codexAuthProbe(provider.authPath);
    },
  };
}
