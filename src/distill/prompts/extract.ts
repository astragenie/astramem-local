import { z } from 'zod';

// FEAT-402 (W4.2) AC-1/AC-9 — entity kinds emitted alongside each atom, in
// the SAME extraction LLM call (no extra call/budget spend). Names are
// normalized at write time via src/entity/normalize.ts, not here — this
// schema only validates shape.
export const EntityKindSchema = z.enum(['product', 'tech', 'person', 'org', 'repo', 'concept']);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const AtomEntitySchema = z.object({
  name: z.string().min(1).max(100),
  kind: EntityKindSchema,
});
export type AtomEntity = z.infer<typeof AtomEntitySchema>;

export const AtomSchema = z.object({
  type: z.enum(['decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event']),
  text: z.string().min(5).max(500),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  evidence: z.string().optional(),
  /** Named things mentioned in this atom (FEAT-402 AC-1). Optional — atoms
   * with no clearly-named entity omit it entirely rather than guessing. */
  entities: z.array(AtomEntitySchema).optional(),
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
      "type": "decision" | "fact" | "lesson" | "command" | "todo" | "note" | "event",
      "text": "<5-500 chars, canonical phrasing>",
      "importance": 0.0-1.0,
      "confidence": 0.0-1.0,
      "evidence": "<optional, short excerpt from source>",
      "entities": [{ "name": "<named thing mentioned>", "kind": "product" | "tech" | "person" | "org" | "repo" | "concept" }]
    }
  ]
}

Types:
- decision: chosen approach/architecture (use SQLite, not Postgres)
- fact: discovered truth about the codebase/system (port 7777 is the default)
- lesson: learning from failure or surprise (Bun does not support better-sqlite3 on Windows)
- command: useful shell incantation (npm test -- --reporter=verbose)
- todo: pending work item explicitly raised
- note: freeform observation or annotation not fitting other types
- event: something that happened at a point in time (deployment, incident, decision meeting)

Entities: list every specific named thing the atom is ABOUT (not every word
mentioned) — a technology, product, repo, person, or organization. kind is
one of:
- product: a named product or app (e.g. "AstraMemory", "GitHub Copilot")
- tech: a language/framework/library/tool/protocol (e.g. "Postgres", "TypeScript", "sqlite-vec")
- person: a named individual
- org: a company or organization
- repo: a named git repository or codebase
- concept: a named pattern, architecture, or idea (e.g. "bitemporal model", "CRDT")
Omit "entities" entirely (or leave it empty) when the atom names nothing specific.

Skip noise: greetings, repeated thinking, false starts, generic AI fluff.
Skip secrets: tokens, API keys, passwords.
Confidence reflects evidence strength: clear conclusion = 0.9; speculation = 0.3.
Importance reflects long-term value: architecture decision = 0.9; one-off command = 0.4.`;

export const EXTRACTION_STRICT_PROMPT = `${EXTRACTION_SYSTEM_PROMPT}

CRITICAL: Output ONLY valid JSON. No markdown, no prose, no code fences. The response must start with { and end with }.`;
