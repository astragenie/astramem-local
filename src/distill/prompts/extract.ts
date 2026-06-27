import { z } from 'zod';

export const AtomSchema = z.object({
  type: z.enum(['decision', 'fact', 'lesson', 'command', 'todo']),
  text: z.string().min(5).max(500),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  evidence: z.string().optional()
});

export const ExtractionSchema = z.object({
  atoms: z.array(AtomSchema)
});

export type Atom = z.infer<typeof AtomSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;

export const EXTRACTION_SYSTEM_PROMPT = `You extract durable knowledge from AI coding agent transcripts.

Output STRICT JSON matching:
{
  "atoms": [
    {
      "type": "decision" | "fact" | "lesson" | "command" | "todo",
      "text": "<5-500 chars, canonical phrasing>",
      "importance": 0.0-1.0,
      "confidence": 0.0-1.0,
      "evidence": "<optional, short excerpt from source>"
    }
  ]
}

Types:
- decision: chosen approach/architecture (use SQLite, not Postgres)
- fact: discovered truth about the codebase/system (port 7777 is the default)
- lesson: learning from failure or surprise (Bun does not support better-sqlite3 on Windows)
- command: useful shell incantation (npm test -- --reporter=verbose)
- todo: pending work item explicitly raised

Skip noise: greetings, repeated thinking, false starts, generic AI fluff.
Skip secrets: tokens, API keys, passwords.
Confidence reflects evidence strength: clear conclusion = 0.9; speculation = 0.3.
Importance reflects long-term value: architecture decision = 0.9; one-off command = 0.4.`;

export const EXTRACTION_STRICT_PROMPT = `${EXTRACTION_SYSTEM_PROMPT}

CRITICAL: Output ONLY valid JSON. No markdown, no prose, no code fences. The response must start with { and end with }.`;
