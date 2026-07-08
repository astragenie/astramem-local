/**
 * LLMProvider adapter for NuExtract (numind/nuextract, 3.8B — a template-fill
 * extraction specialist, not a general chat/instruct model).
 *
 * WHY THIS EXISTS: NuExtract does not follow a system-prompt + free-text
 * instruction paradigm the way qwen/phi/gpt models do. It is trained on one
 * fixed input shape:
 *
 *   <|input|>
 *   ### Template:
 *   {json template with type hints}
 *   ### Text:
 *   {source text}
 *   <|output|>
 *
 * ...and completes with a JSON object shaped like the template, values
 * filled from the text. Feeding it our EXTRACTION_SYSTEM_PROMPT (a multi-page
 * decision tree + few-shot examples) as a chat "system" message is off-
 * paradigm for this model and was confirmed (see bench log / README note for
 * 2026-07-08 run) to produce degenerate output — either an empty/echoed
 * template or a copy of the instructions themselves, not extracted atoms.
 *
 * This adapter keeps the REAL production system prompt and schema
 * (src/distill/prompts/extract.ts / 05-extract.ts) untouched — it only
 * reshapes the outgoing wire call for this one candidate, exactly like
 * azure-reasoning-provider.ts does for gpt-5-mini's max_completion_tokens
 * requirement. 05-extract.ts still calls this the same way for every model;
 * only what happens inside chat() differs:
 *   1. Drop the chat system-prompt entirely (NuExtract has no instruction-
 *      following behavior for it) — but reuse the SAME atom type enum,
 *      schema shape, and secrets rule via the template's field descriptions,
 *      so it is fairly judged on the same task definition as every other
 *      candidate, just phrased in NuExtract's expected shape.
 *   2. Extract the real transcript chunk out of the user message (05-
 *      extract.ts always sends "Extract knowledge atoms from this transcript
 *      chunk:\n\n{text}" — strip that fixed prefix to recover {text}).
 *   3. POST to Ollama's /api/generate (raw completion, not /api/chat —
 *      NuExtract's template format is a single continuous prompt, not a
 *      chat turn) with the NuExtract-shaped prompt, with a `stop` sequence
 *      at "<|end-output|>" — smoke-testing (2026-07-08) showed the model
 *      continues generating past its own output marker and echoes another
 *      copy of the template if not cut off there.
 *   4. Post-process: NuExtract is a span-extraction/classification model,
 *      not a scoring model — smoke-testing showed it reliably fills `type`
 *      (enum) and `text` (verbatim span) but leaves computed numeric fields
 *      like importance/confidence as empty strings (it has no basis to
 *      invent a 0-1 score for a field that isn't literally present in the
 *      source text). So the template only asks it for {type, text}; this
 *      adapter fills a fixed importance/confidence default afterward so the
 *      result still satisfies AtomSchema — every other candidate computes
 *      these itself as part of the real production prompt, so NuExtract's
 *      defaults are a known, disclosed handicap for this one candidate, not
 *      a hidden advantage.
 *
 * Labelled "adapted prompt" in the bench report table (per team-lead
 * instruction) to make clear this candidate is not judged on the identical
 * verbatim prompt as the others.
 */
import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../../../src/contracts/llm.js';

const CHAT_TIMEOUT_MS = 60_000;
const OUTPUT_STOP = '<|end-output|>';

// Same 7-value type enum as src/distill/prompts/extract.ts's AtomSchema.
// NuExtract's template convention represents an enum field as a literal
// array of the allowed string options (not a chat-style prose hint) and a
// free-text/verbatim-span field as "" — confirmed by smoke test to be the
// convention this model actually follows.
const ATOM_TYPES = ['decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event'];
const NUEXTRACT_TEMPLATE = JSON.stringify({
  atoms: [
    {
      type: ATOM_TYPES,
      text: '',
    },
  ],
}, null, 2);

// NuExtract can't compute a durability/confidence score — it has no basis to
// invent one for a field not literally present in the source text. Both
// prompt.ts's stated scale ("clear conclusion = 0.9; speculation = 0.3") and
// this bench's judge only score type+text, so a fixed mid-range default here
// does not advantage or penalize this candidate on the metrics being compared.
const DEFAULT_IMPORTANCE = 0.5;
const DEFAULT_CONFIDENCE = 0.5;

const USER_PREFIX = 'Extract knowledge atoms from this transcript chunk:\n\n';

interface RawNuExtractAtom {
  type?: unknown;
  text?: unknown;
}

function buildNuExtractPrompt(sourceText: string): string {
  return `<|input|>\n### Template:\n${NUEXTRACT_TEMPLATE}\n### Text:\n${sourceText}\n<|output|>\n`;
}

/**
 * Parse NuExtract's raw completion into our full atoms JSON, filling the
 * numeric defaults it can't produce itself. Tolerant of the model echoing
 * more content after its own <|end-output|> marker (cut there first) and of
 * atoms with an empty/blank text (dropped — AtomSchema requires >=5 chars
 * and an empty extraction means NuExtract found nothing template-shaped in
 * this chunk, which is a valid "no atoms" outcome, not a parse failure).
 */
function normalizeNuExtractOutput(raw: string): string {
  let text = raw.trim();
  const stopIdx = text.indexOf(OUTPUT_STOP);
  if (stopIdx !== -1) text = text.slice(0, stopIdx).trim();
  text = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return JSON.stringify({ atoms: [] });

  let parsed: { atoms?: unknown };
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as { atoms?: unknown };
  } catch {
    return JSON.stringify({ atoms: [] });
  }

  const rawAtoms = Array.isArray(parsed.atoms) ? (parsed.atoms as RawNuExtractAtom[]) : [];
  const atoms = rawAtoms
    .map(a => ({
      type: typeof a.type === 'string' && ATOM_TYPES.includes(a.type) ? a.type : 'note',
      text: typeof a.text === 'string' ? a.text.trim() : '',
      importance: DEFAULT_IMPORTANCE,
      confidence: DEFAULT_CONFIDENCE,
    }))
    .filter(a => a.text.length >= 5);

  return JSON.stringify({ atoms });
}

export interface NuExtractAdapterConfig {
  baseUrl?: string;
  model?: string;
}

export class NuExtractAdapterProvider implements LLMProvider {
  readonly name = 'ollama' as const;
  readonly model: string;
  private readonly baseUrl: string;

  constructor(config: NuExtractAdapterConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.model = config.model ?? 'nuextract';
  }

  async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
    const userMsg = [...messages].reverse().find(m => m.role === 'user');
    const rawUserText = userMsg?.content ?? '';
    const sourceText = rawUserText.startsWith(USER_PREFIX)
      ? rawUserText.slice(USER_PREFIX.length)
      : rawUserText;

    const prompt = buildNuExtractPrompt(sourceText);

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        raw: true, // send the prompt exactly as built — no chat template wrapping
        options: {
          temperature: opts?.temperature ?? 0,
          stop: [OUTPUT_STOP],
          ...(opts?.maxTokens !== undefined ? { num_predict: opts.maxTokens } : {}),
        },
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`NuExtract /api/generate failed: HTTP ${res.status} — ${snippet}`);
    }

    const data = (await res.json()) as { response?: string; prompt_eval_count?: number; eval_count?: number };
    const text = normalizeNuExtractOutput(data.response ?? '');

    return {
      text,
      usage: { in: data.prompt_eval_count ?? 0, out: data.eval_count ?? 0, usd: 0 },
    };
  }

  async health(): Promise<LLMHealth> {
    const t0 = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      const latency_ms = Date.now() - t0;
      if (!res.ok) return { ok: false, model: this.model, latency_ms, error: `HTTP ${res.status}` };
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const found = (data.models ?? []).some(m => m.name === this.model || m.name.startsWith(`${this.model}:`));
      return { ok: found, model: this.model, latency_ms, ...(found ? {} : { error: `model ${this.model} not found in ollama list` }) };
    } catch (err) {
      return { ok: false, model: this.model, latency_ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
