import { z } from 'zod';
import { ENTITY_KINDS } from '../../contracts/entity.js';

// FEAT-402 (W4.2) AC-1/AC-9 — entity kinds emitted alongside each atom, in
// the SAME extraction LLM call (no extra call/budget spend). Names are
// normalized at write time via src/entity/normalize.ts, not here — this
// schema only validates shape.
//
// atom@2 (2026-07-09): retagged from the old local-only 6-kind list
// (product|tech|person|org|repo|concept) to the canonical 12-value
// ENTITY_KINDS registry shared with cloud/plugin — see
// src/contracts/entity.ts. `person` -> `actor` (actor covers both humans and
// AI agents; subtype below distinguishes when known); `repo` -> `product`
// (repo/project identity is owned by the structural provenance.project
// field, not an entity kind — cross-repo mentions land in `product`).
export const EntityKindSchema = z.enum(ENTITY_KINDS);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const AtomEntitySchema = z.object({
  name: z.string().min(1).max(100),
  kind: EntityKindSchema,
  /** Meaningful only for ACTOR_KINDS (actor|team|org) — omitted when unknown. */
  subtype: z.enum(['human', 'ai']).optional(),
  /**
   * FEAT-453 §4: fact-level bitemporal validity hints, ISO-8601 date-time
   * strings, extracted ONLY when the source text explicitly states a date
   * for THIS entity relationship. Omitted (not "now") when the source
   * states no date — an absent hint is "no fact-level opinion," which
   * resolves at query time via the parent memory's own valid_from
   * (docs/specs/FEAT-453-bitemporal-design.md §3.1), never baked in here.
   */
  valid_at: z.string().optional(),
  invalid_at: z.string().optional(),
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
      "entities": [{ "name": "<named thing mentioned>", "kind": "actor" | "team" | "org" | "project" | "product" | "workitem" | "decision" | "tech" | "tool" | "concept" | "event" | "other", "subtype": "human" | "ai", "valid_at": "<ISO-8601 date-time, only if the source text states one>", "invalid_at": "<ISO-8601 date-time, only if the source text states one>" }]
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
mentioned) — a person, agent, team, technology, product, or piece of work.
kind is one of:
- actor: a named human OR AI agent (e.g. "Sergey", "Claude Code", "the reviewer bot") —
  set subtype to "human" or "ai" when you can tell which; omit subtype when unsure
- team: a named team or squad within an organization
- org: a company or organization (e.g. "Anthropic", "Astragenie")
- project: a named codebase/repo/workspace the work belongs to (e.g. "astramem-local",
  "memory") — NOT the same as the product it ships; use this for "which repo"
- product: a named product or app the project builds or depends on as a product
  (e.g. "AstraMemory", "GitHub Copilot", "Claude Code" the app rather than the agent)
- workitem: a FEAT/PR/issue/ticket id (e.g. "FEAT-402", "#145")
- decision: a DEC/ADR reference (e.g. "DEC-048", "ADR-001")
- tech: a language/framework/library/protocol the stack depends on (e.g. "Postgres",
  "TypeScript", "sqlite-vec")
- tool: a CLI/dev tool used to do the work (e.g. "vitest", "Docker")
- concept: a named pattern, architecture, or idea — only RECURRING technical concepts
  worth remembering across sessions (e.g. "bitemporal model", "CRDT"), not one-off phrasing
- event: a named happening at a point in time (e.g. "the 2026-07-08 incident")
- other: doesn't fit any kind above but is still a specific named thing
Omit "entities" entirely (or leave it empty) when the atom names nothing specific.
valid_at/invalid_at: omit both for a given entity unless the source text explicitly states
a start and/or end date for THAT entity's specific relationship to the atom (e.g. "Alice was
the approver from January to March") — never infer or default one from context.

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

// ---------------------------------------------------------------------------
// v2 (2026-07-09) — a/b candidate against EXTRACTION_SYSTEM_PROMPT. Adds the
// high-signal, low-cost refinements from the 2026-07-09 prompt review that are
// NOT already owned by the pipeline (dedup=consolidation, canonicalization=
// normalize, staleness=bitemporal supersession are deliberately left out to
// avoid bloating the prompt for small local models): a usefulness/durability
// gate, explicit atomicity, command worth/skip examples, verbatim evidence,
// final-state for facts+config, entity precedence, and unresolved→lesson.
// ---------------------------------------------------------------------------
export const EXTRACTION_SYSTEM_PROMPT_V2 = `You extract durable knowledge from AI coding agent transcripts.

Durability gate — apply to EVERY candidate before emitting it: "Would retrieving this six months from now help another engineer?" If no, skip it. When unsure whether something is durable, SKIP it — a junk memory costs more than a missed marginal one.
Durable = architecture, decisions, config defaults, versions, bug root causes, lessons, constraints, reusable commands.
NOT durable = transient discussion, in-progress thoughts, brainstorming, "maybe"/musings, one-off local debugging — skip these.

Output STRICT JSON matching:
{
  "atoms": [
    {
      "type": "decision" | "fact" | "lesson" | "command" | "todo" | "note" | "event",
      "text": "<5-500 chars, canonical standalone phrasing>",
      "importance": 0.0-1.0,
      "confidence": 0.0-1.0,
      "evidence": "<optional: an EXACT verbatim quote from the source — copy, never paraphrase>",
      "entities": [{ "name": "<named thing mentioned>", "kind": "actor" | "team" | "org" | "project" | "product" | "workitem" | "decision" | "tech" | "tool" | "concept" | "event" | "other", "subtype": "human" | "ai", "valid_at": "<ISO-8601 date-time, only if the source text states one>", "invalid_at": "<ISO-8601 date-time, only if the source text states one>" }]
    }
  ]
}

Atomicity — one atom = exactly ONE durable idea:
- If two claims can be true or false independently, emit two atoms.
- If several details serve one idea, keep them in ONE atom — do not split trivial sub-parts.

For each candidate item, pick type in this order — stop at the first match:
1. command: a shell/CLI incantation worth REUSING (e.g. a specific \`git bisect\` run, a \`kubectl\`/migration incantation). Skip trivial navigation — \`ls\`, \`cd\`, \`pwd\`, \`dir\`.
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
mentioned) — a person, agent, team, technology, product, or piece of work.
kind is one of:
- actor: a named human OR AI agent (e.g. "Sergey", "Claude Code", "the reviewer bot") —
  set subtype to "human" or "ai" when you can tell which; omit subtype when unsure
- team: a named team or squad within an organization
- org: a company or organization (e.g. "Anthropic", "Astragenie")
- project: a named codebase/repo/workspace the work belongs to (e.g. "astramem-local",
  "memory") — NOT the same as the product it ships; use this for "which repo"
- product: a named product or app the project builds or depends on as a product
  (e.g. "AstraMemory", "GitHub Copilot", "Claude Code" the app rather than the agent)
- workitem: a FEAT/PR/issue/ticket id (e.g. "FEAT-402", "#145")
- decision: a DEC/ADR reference (e.g. "DEC-048", "ADR-001")
- tech: a language/framework/library/protocol the stack depends on (e.g. "Postgres",
  "TypeScript", "sqlite-vec")
- tool: a CLI/dev tool used to do the work (e.g. "vitest", "Docker")
- concept: a named pattern, architecture, or idea — only RECURRING technical concepts
  worth remembering across sessions (e.g. "bitemporal model", "CRDT"), not one-off phrasing
- event: a named happening at a point in time (e.g. "the 2026-07-08 incident")
- other: doesn't fit any kind above but is still a specific named thing
Precedence when a name is ambiguous (e.g. "Claude Code"): acting AS an agent → actor;
the software/app itself → product; invoked as a CLI → tool.
Omit "entities" entirely (or leave it empty) when the atom names nothing specific.
valid_at/invalid_at: omit both for a given entity unless the source text explicitly states
a start and/or end date for THAT entity's specific relationship to the atom (e.g. "Alice was
the approver from January to March") — never infer or default one from context.

Skip noise: greetings, repeated thinking, false starts, generic AI fluff.
Skip secrets: tokens, API keys, passwords.
Confidence reflects evidence strength: clear conclusion = 0.9; speculation = 0.3.
Importance reflects long-term value: org-wide/architecture decision = 0.9; implementation
detail = 0.6; one-off command or local debugging = 0.3.

Recall: enumerate EVERY distinct durable item, not just the first one you notice — keep
scanning across topic switches to the end of the chunk. A typical real-work chunk yields
2-6 atoms across different types — a debugging chunk alone often has a lesson AND a
decision AND an event.

Type discipline: assign exactly ONE type per the priority order above. Only reclassify a
current property as a "lesson" when it's genuinely a failure/surprise — otherwise a stable
property stays a "fact".
Final state only: if a decision, fact, or config VALUE changes within the chunk, emit
only the FINAL value (optionally add a lesson for why the earlier one was wrong) — never
the stale, reverted value.
Empty is valid: if the chunk truly contains nothing durable (small talk, a plain
acknowledgment, no claims/choices/errors/commands), output "atoms": [] — do not invent
an atom just to have output.

Examples (illustrative only, not exhaustive):

1. Input: "Should we use Postgres or SQLite? Let's go with SQLite, it's simpler for a single-node local daemon." "Also fyi we're already on Node 20." ->
{"atoms":[
  {"type":"decision","text":"Use SQLite instead of Postgres for the local daemon — simpler for a single-node deployment.","importance":0.8,"confidence":0.9},
  {"type":"fact","text":"The project runs on Node 20.","importance":0.4,"confidence":0.9}
]}

2. Input: "The reinstall step threw Access is denied. I haven't figured out why yet." ->
{"atoms":[
  {"type":"lesson","text":"reinstall fails with 'Access is denied' — cause not yet identified.","importance":0.6,"confidence":0.7,"evidence":"The reinstall step threw Access is denied."}
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
