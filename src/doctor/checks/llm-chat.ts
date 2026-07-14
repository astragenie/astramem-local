import type { Check, CheckResult } from '../types.js';
import type { LLMProvider } from '../../contracts/llm.js';
import { llmChatProbe } from '../probes/llm-chat-probe.js';

// ─── Check: LLM chat probe (real 1-token call) ────────────────────────────────

export function checkLLMChat(provider: LLMProvider, label: string): Check {
  return {
    name: `LLM chat probe (${label})`,
    tier: 'full', // real, potentially metered LLM call
    async run(): Promise<CheckResult> {
      return llmChatProbe(provider);
    },
  };
}
