export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOpts {
  temperature?: number;
  json?: boolean;
  maxTokens?: number;
}

export interface ChatUsage {
  in: number;
  out: number;
  usd: number;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage;
}

export interface LLMHealth {
  ok: boolean;
  model: string;
  latency_ms: number;
  error?: string;
}

export interface LLMProvider {
  readonly name: 'ollama' | 'azure-openai';
  readonly model: string;
  chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult>;
  health(): Promise<LLMHealth>;
}
