import { z } from 'zod';

/**
 * D-DEF1 fix — turn-flattening defect.
 *
 * The canonical ingest envelope (server/routes/ingest.ts) stores turns as
 * `JSON.stringify(turns)` in `transcripts.content` — a structured
 * `[{role, text, ts}]` array. The distill pipeline's stages 1-3
 * (cleanup/normalize/chunk) were built for plain text with `role: text`
 * line-prefixed turn boundaries — the same convention the legacy envelope's
 * raw `content` string already uses (see distill/stages/03-chunk.ts
 * `TURN_BOUNDARY_RE`). `JSON.stringify` produces a single-line string (no
 * embedded newlines), so when that raw JSON is fed through unchanged, stage
 * 3's turn-boundary detector never fires: the whole transcript becomes one
 * opaque "turn" that gets sliced blindly by character count, and role
 * attribution is lost before stage 1 even runs (CHANGELOG 0.2.0 "Known
 * issues" — D-DEF1: "fix is scoped to... flatten turns to `role: text\n`
 * pairs before pipeline entry").
 *
 * This converts the canonical JSON-turns shape into `role: text` pairs (one
 * per line) — the format the pipeline stages already parse. Legacy
 * plain-text content (or any JSON that isn't a turns array) passes through
 * unchanged.
 */
const TurnLikeSchema = z.object({
  role: z.string(),
  text: z.string(),
});

export function flattenTranscriptContent(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content; // legacy plain text — not JSON, pass through unchanged
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return content;
  }

  const turns: Array<{ role: string; text: string }> = [];
  for (const item of parsed) {
    const result = TurnLikeSchema.safeParse(item);
    if (!result.success) {
      // Not a turns array (some other JSON payload) — leave untouched.
      return content;
    }
    turns.push(result.data);
  }

  return turns.map(t => `${t.role}: ${t.text}`).join('\n');
}
