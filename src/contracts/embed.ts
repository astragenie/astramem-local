export interface EmbedHealth {
  ok: boolean;
  model: string;
  dim: number;
  error?: string;
}

export interface EmbedProvider {
  readonly name: 'ollama' | 'azure-openai';
  readonly model: string;
  readonly dim: 1024;
  embed(texts: string[]): Promise<Float32Array[]>;
  health(): Promise<EmbedHealth>;
}
