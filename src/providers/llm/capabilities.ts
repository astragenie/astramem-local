import { LLM_PROVIDER_NAMES, type LLMProviderName } from '../../contracts/llm.js';

/**
 * Structured-output capability per LLM provider (Wave 1 BYO, FEAT-536 AC-4).
 *
 *  - 'json_object': the provider only guarantees SOME valid JSON back
 *    (`response_format:{type:'json_object'}` or equivalent) — no shape
 *    guarantee. `ChatOpts.jsonSchema` is accepted by every provider's
 *    `chat()` signature but silently ignored by these (see
 *    contracts/llm.ts's `jsonSchema` doc comment). azure-openai,
 *    openai-compatible (and every BYO preset resolving through it — Groq,
 *    Gemini, Kimi, DeepSeek), and codex-subscription all fall in this
 *    bucket today.
 *  - 'strict-schema': the provider can be handed an actual JSON Schema and
 *    constrains generation to it. Ollama (`format: <schema>` in place of the
 *    bare string `"json"`).
 *  - 'tool-use': the provider has no native "give me this JSON shape" mode,
 *    but forced tool-use achieves the same effect (Anthropic — see
 *    anthropic.ts's module doc comment for the tool_use.input round-trip).
 *
 * This is a genuine capability MAP, not a restatement of `LLM_PROVIDER_NAMES`
 * — every entry here also has a real consumer: `05-extract.ts`'s
 * `callExtract` (the extraction path this AC exists for) uses
 * `supportsJsonSchema()` to decide whether to bother constructing/sending
 * `jsonSchema` at all. Sending it to a `'json_object'`-only provider was
 * already a harmless no-op (those providers ignore the field), so this is
 * not a behavior change for existing providers — it's the registry actually
 * being consulted, not dead code sitting next to the real per-provider
 * `if (opts?.jsonSchema)` branches inside each provider's own `chat()`.
 */
export type StructuredOutputCapability = 'json_object' | 'strict-schema' | 'tool-use';

export const LLM_STRUCTURED_OUTPUT_CAPABILITY: Record<LLMProviderName, StructuredOutputCapability> = {
  ollama: 'strict-schema',
  'azure-openai': 'json_object',
  'openai-compatible': 'json_object',
  'codex-subscription': 'json_object',
  anthropic: 'tool-use',
};

// Compile-time-adjacent completeness guard: iterates LLM_PROVIDER_NAMES so a
// future provider added to that array without a capability entry here fails
// at runtime (module load, i.e. immediately under any test) rather than
// silently falling through `?? 'json_object'` somewhere downstream — the
// same "declare, don't assume" posture as the rest of this registry.
for (const name of LLM_PROVIDER_NAMES) {
  if (!(name in LLM_STRUCTURED_OUTPUT_CAPABILITY)) {
    throw new Error(`LLM_STRUCTURED_OUTPUT_CAPABILITY is missing an entry for provider '${name}'`);
  }
}

/** Does this provider honor `ChatOpts.jsonSchema` (a real shape constraint),
 *  as opposed to only the bare `json: true` "some JSON" guarantee? */
export function supportsJsonSchema(name: LLMProviderName): boolean {
  return LLM_STRUCTURED_OUTPUT_CAPABILITY[name] !== 'json_object';
}
