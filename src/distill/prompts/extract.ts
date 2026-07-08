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

For each candidate item, pick type in this order — stop at the first match:
1. command: a shell/CLI incantation worth reusing
2. todo: pending work explicitly raised
3. event: something that happened at a point in time (deployment, incident, meeting)
4. decision: a choice was made between alternatives (pick this over "fact" whenever
   two or more options were weighed, even if only one is mentioned by name)
5. lesson: a failure, error, or surprise — extract it EVEN IF unresolved; do not
   require a fix or root cause to exist yet
6. fact: a verifiable, current property of the code/system (a value, a config
   default, a version, a status)
7. note: opinions, preferences, or style remarks that don't fit above

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
Importance reflects long-term value: architecture decision = 0.9; one-off command = 0.4.

Recall: enumerate EVERY distinct durable item, not just the first one you notice.
A typical real-work chunk yields 2-6 atoms across different types — a debugging
chunk alone often has a lesson AND a decision AND an event. Keep scanning to the
end of the chunk before stopping. If a decision is reversed later in the same
chunk, output only the FINAL value as the decision (optionally add a lesson for
why the first value was wrong) — never emit the stale, reverted value.
Exception: if the chunk truly contains nothing durable (small talk, a plain
acknowledgment, no claims/choices/errors/commands), output "atoms": [] — do not
invent an atom just to have output.

Examples (illustrative only, not exhaustive):

1. Input: "Should we use Postgres or SQLite? Let's go with SQLite, it's simpler for a single-node local daemon." "Also fyi we're already on Node 20." ->
{"atoms":[
  {"type":"decision","text":"Use SQLite instead of Postgres for the local daemon — simpler for a single-node deployment.","importance":0.8,"confidence":0.9},
  {"type":"fact","text":"The project runs on Node 20.","importance":0.4,"confidence":0.9}
]}

2. Input: "The reinstall step threw Access is denied. I haven't figured out why yet." ->
{"atoms":[
  {"type":"lesson","text":"reinstall fails with 'Access is denied' — cause not yet identified.","importance":0.6,"confidence":0.7}
]}

3. Input: "Users get logged out after 15 min. Found it — maxAge was set in seconds but the library expects ms. Fixed by adding a named constant. Also, switching topics, let's split CI lint/test into parallel jobs to cut wall-clock time." ->
{"atoms":[
  {"type":"lesson","text":"Refresh-token maxAge was set in seconds while the cookie library expected milliseconds, causing premature logout.","importance":0.7,"confidence":0.9},
  {"type":"decision","text":"Fix the cookie expiry bug via an explicit named ms constant.","importance":0.6,"confidence":0.9},
  {"type":"decision","text":"Split the CI 'build' job into parallel 'lint' and 'test' jobs to reduce wall-clock time.","importance":0.6,"confidence":0.8}
]}

4. Input: "hey" / "Hey! What can I help with?" / "just checking you're there" / "cool thanks that's all" ->
{"atoms":[]}

5. Input: "Set epsilon to 0.3." ... "Actually wait, 0.3 is too aggressive, use 0.1 instead, matching the ADR-010 default." ->
{"atoms":[
  {"type":"decision","text":"Set epsilon to 0.1, matching the ADR-010 default (not the initially proposed 0.3, which was reverted).","importance":0.7,"confidence":0.9},
  {"type":"lesson","text":"epsilon=0.3 was too aggressive — reverted in favor of 0.1.","importance":0.5,"confidence":0.8}
]}`;

export const EXTRACTION_STRICT_PROMPT = `${EXTRACTION_SYSTEM_PROMPT}

CRITICAL: Output ONLY valid JSON. No markdown, no prose, no code fences. The response must start with { and end with }.`;
