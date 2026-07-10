/**
 * Minimal Azure OpenAI chat-completions client — plain fetch, no `openai`
 * npm dependency (keeps package.json untouched, per the "new files only"
 * scope for this adapter).
 *
 * gpt-5-mini is a reasoning model: it takes `max_completion_tokens` (not
 * `max_tokens`) and `reasoning_effort`, and does not accept a `temperature`
 * override (verified live 2026-07-08 — omit it entirely, default is fine).
 */
import type { AzureConfig } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AzureChatOptions {
  messages: ChatMessage[];
  maxCompletionTokens: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  deployment: string;
}

export async function azureChatComplete(cfg: AzureConfig, opts: AzureChatOptions): Promise<string> {
  const url = `${cfg.endpoint.replace(/\/$/, '')}/openai/deployments/${opts.deployment}/chat/completions?api-version=${cfg.apiVersion}`;
  const body: Record<string, unknown> = {
    messages: opts.messages,
    max_completion_tokens: opts.maxCompletionTokens,
  };
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': cfg.key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(`Azure chat completion failed (HTTP ${res.status}) on deployment ${opts.deployment}: ${json.error?.message ?? JSON.stringify(json)}`);
  }
  const choice = json.choices?.[0];
  const content = choice?.message?.content;
  if (content === undefined) {
    throw new Error(`Azure chat completion returned no content (finish_reason=${choice?.finish_reason ?? 'unknown'}) — raw: ${JSON.stringify(json)}`);
  }
  return content;
}
