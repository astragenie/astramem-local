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

// FEAT-481 SLICE-2/SLICE-435 — entity-to-entity relation triples, nested
// inside the atom that names both endpoints (design doc §2.1: a memory row
// doesn't exist until stage 8, so nesting inside the atom gives every triple
// exactly one future evidence_memory_id, for free). Closed lowercase
// snake_case predicate enum matching cloud's (`memory` repo)
// security-gated, case-sensitive allow-list exactly
// (`EntityPersister.cs`/`IExtractionPipeline.cs`, verified
// docs/specs/FEAT-481-design.md §0.1/§2.4), plus a local-only `'other'`
// bucket excluded from any future sync payload. A predicate string that
// doesn't match one of these 11 exact values is DROPPED at parse time
// (src/distill/stages/05-extract.ts's filterAtomRelations), never coerced to
// `'other'` — unlike entity `kind`, this is a closed vocabulary the model is
// asked to hit exactly, not a safe-narrow for stale/unknown values.
export const RELATION_PREDICATES = [
  'uses', 'depends_on', 'replaces', 'supersedes', 'mentions',
  'relates_to', 'part_of', 'owned_by', 'assigned_to', 'created_by',
] as const;
export type RelationPredicate = (typeof RELATION_PREDICATES)[number] | 'other';

export const AtomRelationSchema = z.object({
  subject: z.string().min(1).max(100),
  predicate: z.enum([...RELATION_PREDICATES, 'other']),
  object: z.string().min(1).max(100),
  /** Per-triple excerpt; falls back to the atom's own `evidence`/`text` at
   * stage 8 write time when omitted, so `entity_relations.source_excerpt`
   * (NOT NULL) is always satisfiable — design doc §2.1/§1. */
  evidence: z.string().optional(),
  /** Model-reported per-triple confidence (design doc §6) — kept as a real
   * signal, not the hardcoded constant cloud's own server-side path writes.
   * Falls back to the atom's own `confidence` at stage 8 when omitted. */
  confidence: z.number().min(0).max(1).optional(),
  valid_at: z.string().optional(),
  invalid_at: z.string().optional(),
});
export type AtomRelation = z.infer<typeof AtomRelationSchema>;

export const AtomSchema = z.object({
  type: z.enum(['decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event']),
  /** FEAT-479 (SLICE-433 AC-7): cap bumped 500 -> 1000 so the v3 engineering
   * prompt's 300-800 char rich-shape target for lesson/decision (claim +
   * rationale + consequence + provenance) is never schema-rejected or
   * silently truncated. `memories.text` is a plain SQLite TEXT column
   * (migrations/001-init.sql) — no length constraint at the DB layer, so
   * this is a Zod-only change; no migration needed. */
  text: z.string().min(5).max(1000),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  evidence: z.string().optional(),
  /** Named things mentioned in this atom (FEAT-402 AC-1). Optional — atoms
   * with no clearly-named entity omit it entirely rather than guessing. */
  entities: z.array(AtomEntitySchema).optional(),
  /** FEAT-481 (SLICE-2/SLICE-435): entity-to-entity relation triples this
   * atom asserts. Optional and additive — absent on every atom from an old
   * envelope/prompt, byte-identical to pre-FEAT-481 behavior. No-hallucination
   * guard (design doc §2.2/AC-7): subject/object must each match a name in
   * this SAME atom's own `entities[]` list, enforced post-parse (not by a
   * zod `.refine()`, so a bad triple drops without failing the whole atom —
   * see filterAtomRelations in 05-extract.ts). */
  relations: z.array(AtomRelationSchema).optional(),
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
// FEAT-479 (D3 §3.2) — extraction profile registry.
// ---------------------------------------------------------------------------

/** Which prompt family stage 5 (05-extract.ts) resolves per-run. See
 * `Config['distill']['extractProfile']` (src/config/config.ts) for the
 * config surface and `PipelineContext.extractProfile` (src/distill/
 * pipeline.ts) for the per-transcript envelope override. */
export type ExtractProfile = 'engineering' | 'conversational';

/**
 * FEAT-479 (D3 S3.2) AC-9/AC-10 (SLICE-434) - the mem0/Graphiti-pattern
 * liberal-extraction profile for conversational (non-engineering) transcripts.
 * Memories here are self-contained explanations, not contextless trivia -
 * mem0-pattern liberal extraction (15-80 word standalone sentences, pronouns
 * resolved, proper nouns preserved, relative dates grounded to an in-
 * transcript observation date when one exists) plus Graphiti-pattern
 * possessor qualification (attribute every fact to its owner by name) and an
 * explicit banned-abstractions negative list (no vague summaries, no
 * meta-commentary, no sentiment padding). Unlike the engineering v3 prompt's
 * type-conditioned richness rule (300-800 chars for lesson/decision), EVERY
 * atom here stays atomic/short (~15-80 words) regardless of type - personal
 * facts are frequently superseded as life moves on, so a single clean,
 * independently-replaceable sentence beats a rich paragraph. The 7-type
 * taxonomy and AtomEntitySchema/EntityKindSchema contract are unchanged -
 * only the entity-kind description text below is trimmed to the kinds that
 * actually recur in personal conversation (actor/org/product/event/other);
 * the full 12-kind enum still validates whatever the model emits.
 *
 * UPDATE (temporal-grounding fix, 2026-07-13): captured_at IS now threaded
 * into this call. 05-extract.ts's extractChunk takes an optional
 * `sessionDateIso` param (an ISO calendar date, formatted from
 * PipelineContext.capturedAtMs by pipeline.ts's stage-5 call site) and
 * callExtract prepends it as a literal "Observation date: <date>" line
 * ahead of the transcript chunk in the user message. The date-grounding
 * rule below now points at that injected line FIRST, falling back to the
 * old conditional wording ("if the transcript states or implies...") only
 * when no sessionDateIso was available (legacy v0.0 envelopes, direct
 * /remember calls) — those callers see byte-identical behavior to before
 * this fix.
 */
export const EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL = `You extract durable PERSONAL knowledge from conversational transcripts — chats, journals, voice-note transcripts, casual check-ins between a person and an assistant — not engineering or coding sessions.

Output STRICT JSON matching:
{
  "atoms": [
    {
      "type": "decision" | "fact" | "lesson" | "command" | "todo" | "note" | "event",
      "text": "<one self-contained sentence, roughly 15-80 words>",
      "importance": 0.0-1.0,
      "confidence": 0.0-1.0,
      "evidence": "<optional, short excerpt from source>",
      "entities": [{ "name": "<named thing mentioned>", "kind": "actor" | "team" | "org" | "project" | "product" | "workitem" | "decision" | "tech" | "tool" | "concept" | "event" | "other", "subtype": "human" | "ai", "valid_at": "<ISO-8601 date-time, only if the source text states one>", "invalid_at": "<ISO-8601 date-time, only if the source text states one>" }]
    }
  ]
}

Liberal extraction (mem0 pattern) — a DIFFERENT posture from engineering transcripts: capture EVERY durable personal fact, preference, relationship, plan, or event mentioned, not only the highest-value few. A stated preference, a named relationship, or a planned date is cheap to keep and expensive to lose — bias toward extracting whenever a candidate is genuinely durable, rather than filtering it out because it seems minor.

Self-containment — every atom must read as ONE complete, standalone sentence of roughly 15-80 words, true on its own without the rest of the conversation:
- Resolve every pronoun to the actual named person before writing the atom. Never emit "she started her new job", "his sister called him", or "they're moving in June" — write the real names: "Priya started her new job", "Marcus's sister called him", "the Nguyen family is moving in June".
- Preserve proper nouns EXACTLY as given — people's names, place names, employer and school names, product and brand names. Never substitute a generic noun ("her employer", "the city") for a name you were actually told.
- Possessor qualification (Graphiti pattern): whenever a fact belongs to a specific person, name that owner inside the sentence itself. Write "Sergey's daughter Alice starts kindergarten in September, moving up from the preschool she has attended the past two years", never a bare "daughter starts kindergarten in September" or "starts school in the fall" — a reader must never have to guess whose fact this is.

Date grounding: if a line reading "Observation date: <YYYY-MM-DD>" appears immediately before the transcript chunk below, treat that as the authoritative anchor and resolve every relative date expression ("yesterday", "last week", "next month", "three years ago") against it — write the resolved absolute date in ISO-8601 form (YYYY-MM-DD) directly into the atom's text in place of the relative phrase, not alongside it. Otherwise, if the transcript states or implies an explicit observation/capture date (a timestamp, a line like "today is 2026-07-13", a dated header), resolve relative dates against that anchor instead. If no anchor exists at all — no Observation date line and no in-transcript date — keep the original relative phrasing rather than inventing an absolute date you were not given — a guessed date is worse than an honest relative one.

Banned abstractions — NEVER emit these shapes, even when a summary version is technically accurate:
- Vague summaries: "discussed plans for the weekend", "talked about work stuff", "had a conversation about the move" — these describe the CONVERSATION itself, not a fact about the person's life; extract the actual plan, fact, or decision underneath instead, or emit nothing if there genuinely isn't one.
- Meta-commentary: "the user shared an update", "mentioned something about the family" — never describe that a topic came up; state plainly what was actually said.
- Sentiment padding: "seemed happy about it", "expressed some excitement" — skip a standalone mood observation unless the feeling itself is the durable, recurring fact (an ongoing preference or aversion belongs in "note", not a one-off reaction).

Type-conditioned shape: conversational content maps mostly onto fact, note, event, and decision (a settled plan or choice); command and todo apply only when the source is literally a task, chore, or reminder, and lesson only when the person explicitly names something they personally learned. Regardless of type, every atom here stays atomic, single-valued, and roughly 15-80 words — do NOT apply the engineering profile's 300-800-character rich-shape rule (claim + rationale + consequence + provenance). Personal facts — a job, a relationship status, an address, a due date — are frequently corrected or superseded as life moves on, so keep each one a single clean, independently replaceable statement rather than a multi-clause paragraph.

For each candidate item, pick type in this order — stop at the first match:
1. event: something that happened, or is scheduled to happen, at a specific point in time (a birth, a move, a wedding, a diagnosis, a graduation, a trip)
2. decision: a stated choice settled between real alternatives (a school picked, a job offer accepted, a name chosen)
3. todo: an explicit pending personal task, errand, or reminder ("pick up the dry cleaning Thursday")
4. command: a literal recipe, routine, or set of steps the person follows step by step (rare in personal conversation — most personal content is NOT this)
5. fact: a current, stable property of a person's life (job, employer, address, relationship status, age, a health condition, a pet's name)
6. note: a stated preference, opinion, aversion, or recurring habit (a favorite food, a dislike of crowds, always running on Sunday mornings)
7. lesson: something the person explicitly names as a takeaway they personally learned from an experience

Entities: list every specific named person, place, organization, or thing the atom is about. kind is one of:
- actor: a named person — set subtype to "human" unless the transcript makes clear it is an AI/assistant
- org: a named company, school, or organization
- product: a named brand, app, or product
- event: a named happening (e.g. "Alice's graduation")
- other: a specific named thing that doesn't fit above (a place, a pet's name, a named condition)
Omit "entities" entirely when the atom names nothing specific.
valid_at/invalid_at: omit both unless the source explicitly states a start and/or end date for that entity's relationship to the atom.

Skip noise: greetings, small talk with no durable content, filler acknowledgments ("cool", "got it", "haha", "yeah totally").
Skip secrets: passwords, tokens, financial account numbers, government ID numbers.
Confidence reflects how clearly and directly the fact was stated: an explicit, unambiguous statement = 0.9; a hedge or maybe = 0.4.
Importance reflects how durable and personally significant the fact is: a life event, relationship, or major decision = 0.8; a minor passing preference = 0.4.

Recall: enumerate every distinct durable personal item in the chunk, not just the first one — a single real conversation often yields a life event, a couple of facts, and a preference or two across different topics.
Empty is valid: if the chunk truly contains nothing durable (small talk, filler, no stated fact/plan/preference), output "atoms": [] — do not invent an atom just to have output.

Examples (illustrative only, not exhaustive — the shape of these IS the spec: one self-contained sentence per atom, names resolved, possessor stated):

1. Input: "My daughter Alice is starting kindergarten in September, I honestly can't believe it — she's moving up from the same preschool she's been at for two years." ->
{"atoms":[
  {"type":"event","text":"Sergey's daughter Alice is starting kindergarten in September, moving up from the same preschool she has attended for the past two years.","importance":0.8,"confidence":0.9,"entities":[{"name":"Sergey","kind":"actor","subtype":"human"},{"name":"Alice","kind":"actor","subtype":"human"}]}
]}

2. Input: "I moved to Austin last month for a new job at Anthropic. Honestly loving the move so far, way better weather than where I was before." ->
{"atoms":[
  {"type":"fact","text":"Sergey moved to Austin last month to start a new job at Anthropic, relocating from where he had been living before.","importance":0.8,"confidence":0.9,"entities":[{"name":"Sergey","kind":"actor","subtype":"human"},{"name":"Austin","kind":"other"},{"name":"Anthropic","kind":"org"}]},
  {"type":"note","text":"Sergey has been enjoying his recent move to Austin so far, and prefers the weather there over where he lived previously.","importance":0.4,"confidence":0.8,"entities":[{"name":"Sergey","kind":"actor","subtype":"human"},{"name":"Austin","kind":"other"}]}
]}

3. Input: "We ended up going with the Montessori school down the street for Alice instead of the public one, mostly because of the smaller class sizes." ->
{"atoms":[
  {"type":"decision","text":"Sergey and his wife chose the Montessori school down the street for their daughter Alice instead of the local public school, mainly because of its smaller class sizes.","importance":0.7,"confidence":0.85,"entities":[{"name":"Sergey","kind":"actor","subtype":"human"},{"name":"Alice","kind":"actor","subtype":"human"}]}
]}

4. Input: "Yeah we just talked about the weekend and stuff, nothing major, haha." ->
{"atoms":[]}

5. NEGATIVE EXAMPLE — what NOT to produce. Input: "We talked about my new job for a bit and how my sister Priya's been dealing with a lot lately with her divorce." ->
WRONG (vague summary + unresolved possessor + meta-commentary about the conversation itself — this is exactly the failure mode the banned-abstractions and possessor-qualification rules above exist to prevent):
{"type":"note","text":"Discussed work stuff and some family things, sister going through something hard.","importance":0.5,"confidence":0.5}
RIGHT (self-contained, possessor-qualified, states the actual fact instead of describing the conversation):
{"type":"fact","text":"Sergey's sister Priya is currently going through a divorce, and has been having a difficult time with it lately.","importance":0.7,"confidence":0.8,"entities":[{"name":"Sergey","kind":"actor","subtype":"human"},{"name":"Priya","kind":"actor","subtype":"human"}]}`;

/**
 * Resolve the extraction system prompt for one pipeline run. Precedence
 * (highest first):
 *
 * 1. `envOverride === 'v2'` — the pre-existing `ASTRA_EXTRACT_PROMPT=v2` a/b
 *    lever. Selects the v2 candidate prompt REGARDLESS of `profile` —
 *    preserves the exact override semantics 05-extract.ts always had, now
 *    just evaluated per-call instead of once at module load (FEAT-479 AC-2).
 * 2. `envOverride === 'v1'` — SLICE-433 rollback lever. Selects the original
 *    (pre-SLICE-433) engineering prompt verbatim, now that it is no longer
 *    the default — an explicit escape hatch back to the old shape if v3
 *    regresses recall or a local model can't follow the richer instructions.
 * 3. `profile === 'conversational'` — the mem0/Graphiti-pattern liberal-
 *    extraction profile (FEAT-479 AC-9/AC-10, SLICE-434). Self-contained
 *    personal-fact sentences, possessor qualification, banned-abstractions
 *    negative list — see EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL's own doc
 *    comment for the full design rationale.
 * 4. Otherwise (`'engineering'`, `null`, or `undefined`) — the SLICE-433
 *    engineering-rich v3 prompt (FEAT-479 AC-5/AC-6). v3 REPLACES v1 as the
 *    engineering default (design doc §3.2 / review item 3): v1 produced the
 *    contextless-trivia shape the whole FEAT exists to fix, so leaving it as
 *    the silent default while v3 sat behind an opt-in flag would mean the
 *    fix never actually ships to users who don't know to ask for it. v1
 *    remains fully available via `ASTRA_EXTRACT_PROMPT=v1` for rollback.
 */
export function resolveExtractionPrompt(
  profile: ExtractProfile | null | undefined,
  envOverride: string | undefined,
): string {
  if (envOverride === 'v2') return EXTRACTION_SYSTEM_PROMPT_V2;
  if (envOverride === 'v1') return EXTRACTION_SYSTEM_PROMPT;
  if (profile === 'conversational') return EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL;
  return EXTRACTION_SYSTEM_PROMPT_V3;
}

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

// ---------------------------------------------------------------------------
// v3 (SLICE-433, 2026-07-13) — FEAT-479 AC-5/AC-6/AC-8. REPLACES v1 as the
// engineering-profile default (see resolveExtractionPrompt precedence doc
// above for the rollback lever). Adds two things v1/v2 never stated: a
// TYPE-CONDITIONED richness rule (lesson/decision: 300-800 chars, claim +
// rationale + consequence/tradeoff + provenance anchor; fact/command/todo/
// event/note: stay atomic/short — design D4 option (a), stated explicitly
// as an instruction, not left to be inferred from example shape) and a
// self-containment rule (mem0 pattern: resolve pronouns, never genericize a
// proper noun, ground relative dates against an in-transcript anchor when
// one exists). The 7-type taxonomy, priority order, and entity-extraction
// contract are carried over UNCHANGED from v1/v2 — this slice does not touch
// entity kinds, precedence, or valid_at/invalid_at semantics.
// UPDATE (FEAT-481 SLICE-435, 2026-07-13): entity-to-entity `relations[]`
// added, engineering profile only (design doc §2.5 scopes the prompt
// addition to this shared skeleton; the conversational profile, SLICE-434,
// is not extended here — no design-doc direction to add it there, and
// personal-conversation transcripts have materially weaker signal for
// closed-vocabulary triples than engineering ones). See the "Relations"
// section below the Entities section for the closed predicate list,
// possessor-qualification, and same-atom no-hallucination guidance; the
// filtering/dropping enforcement itself lives in
// src/distill/stages/05-extract.ts (filterAtomRelations) and stage 8
// (resolveAtomRelations), not in this prompt text.
// Every few-shot example below was rewritten or added for this version — the
// examples ARE the spec, so a lesson/decision example that stayed at v1's
// ~90-char shape would directly contradict the richness rule stated above
// it. Example 7 is a negative example (WRONG vs RIGHT) demonstrating the
// exact contextless-trivia failure mode this prompt exists to fix.
// Size note (review fix, 2026-07-13; updated FEAT-481 SLICE-435, same date):
// this prompt is ~18.4k chars / ~4.6k tokens (chars/4) on its own after the
// relations[] guidance addition (was ~15.3k/~3.8k before) — before the
// transcript chunk or the model's own output are counted. Total estimated
// context (prompt + an 800-token chunk + maxTokens 2500 + the 512-token
// NUM_CTX_SLACK_TOKENS margin) is ~8.4k tokens, still well inside Ollama's
// 16384 NUM_CTX_CAP — see the context-budget test in
// tests/distill/prompts/extract.test.ts, which is the tripwire if a future
// addition pushes this over budget. Local providers with a small default
// context window (Ollama's per-model default, observed 4096 for
// qwen2.5:7b) need num_ctx >= ~8k to fit prompt + chunk + output without
// silent truncation; src/providers/llm/ollama.ts now sizes num_ctx
// dynamically per call rather than requiring every caller to know this
// prompt's size up front.
// ---------------------------------------------------------------------------
export const EXTRACTION_SYSTEM_PROMPT_V3 = `You extract durable knowledge from AI coding agent transcripts.

Durability gate — apply to EVERY candidate before emitting it: "Would retrieving this six months from now help another engineer?" If no, skip it. When unsure whether something is durable, SKIP it — a junk memory costs more than a missed marginal one.
Durable = architecture, decisions, config defaults, versions, bug root causes, lessons, constraints, reusable commands.
NOT durable = transient discussion, in-progress thoughts, brainstorming, "maybe"/musings, one-off local debugging — skip these.

Output STRICT JSON matching:
{
  "atoms": [
    {
      "type": "decision" | "fact" | "lesson" | "command" | "todo" | "note" | "event",
      "text": "<5-1000 chars; length is TYPE-CONDITIONED — see richness rule below>",
      "importance": 0.0-1.0,
      "confidence": 0.0-1.0,
      "evidence": "<optional: an EXACT verbatim quote from the source — copy, never paraphrase>",
      "entities": [{ "name": "<named thing mentioned>", "kind": "actor" | "team" | "org" | "project" | "product" | "workitem" | "decision" | "tech" | "tool" | "concept" | "event" | "other", "subtype": "human" | "ai", "valid_at": "<ISO-8601 date-time, only if the source text states one>", "invalid_at": "<ISO-8601 date-time, only if the source text states one>" }],
      "relations": [{ "subject": "<entity name, must appear in this atom's own entities[]>", "predicate": "uses" | "depends_on" | "replaces" | "supersedes" | "mentions" | "relates_to" | "part_of" | "owned_by" | "assigned_to" | "created_by" | "other", "object": "<entity name, must appear in this atom's own entities[]>", "confidence": 0.0-1.0 }]
    }
  ]
}

Atomicity — one atom = exactly ONE durable idea:
- If two claims can be true or false independently, emit two atoms.
- If several details serve one idea, keep them in ONE atom — do not split trivial sub-parts.

Richness rule — length and content are TYPE-CONDITIONED. State this explicitly; do not rely on
the examples alone to teach it:
- lesson and decision: write 300-800 characters. The atom MUST carry ALL of: (1) the claim
  itself, (2) the rationale behind it, (3) the consequence or tradeoff it produces, and (4) a
  provenance anchor — name the specific feature, file, command, config key, or error string the
  atom is ABOUT, so a reader six months from now knows exactly what it refers to without
  re-reading the transcript. A short lesson/decision that states a bare conclusion with no
  rationale and no provenance anchor is a FAILED extraction, even when it is grammatically fine
  and factually correct — "Re-verify the fix before committing" is the failure mode this rule
  exists to prevent.
- fact, command, todo, event, note: stay atomic and short — ONE value, ONE command, ONE pending
  action. Do NOT pad these with rationale or backstory; that dilutes atomicity and makes each one
  harder to supersede independently when the underlying value changes.
- Why the split exists: lesson/decision atoms are rarely superseded (the reasoning stays valid
  even after the codebase moves on), so spending 300-800 characters on one is safe and valuable.
  fact/command/todo/event/note atoms are frequently superseded (a config default, a version, a
  status changes) — bundling rationale into an atomic type would force every future correction to
  rewrite prose instead of cleanly replacing one short value.

Self-containment — every atom must stand alone without the transcript (mem0-pattern):
- Resolve pronouns and vague references. Never emit "the fix", "it", "that config", "this
  issue" — name exactly WHICH fix, WHICH config key, WHICH issue (by file, feature id, error
  string, or component name) the atom refers to.
- Never genericize a proper noun. Keep exact versions ("v0.9.1", not "the new version"), exact
  model names ("qwen2.5-coder:7b", not "the coding model"), exact error strings verbatim
  ("SQLITE_NOTADB", not "a database error").
- Ground relative dates against an anchor. If a line reading "Observation date: <YYYY-MM-DD>"
  appears immediately before the transcript chunk below, treat it as the authoritative anchor and
  resolve "yesterday" / "last week" / "this morning" / "three years ago" to an absolute ISO-8601
  date (YYYY-MM-DD) against it, replacing the relative phrase rather than appending to it.
  Otherwise, ground against an anchor stated in the transcript itself (a log timestamp, an
  explicit "as of 2026-07-10") when one exists. If no date anchor exists anywhere — no Observation
  date line and no in-transcript anchor — keep the original relative phrasing rather than
  inventing a date.

For each candidate item, pick type in this order — stop at the first match:
1. command: a shell/CLI incantation worth REUSING (e.g. a specific \`git bisect\` run, a
   \`kubectl\`/migration incantation). Skip trivial navigation — \`ls\`, \`cd\`, \`pwd\`, \`dir\`.
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

Relations (FEAT-481): for each atom, optionally list entity-to-entity relation triples this
atom's own text asserts. subject and object MUST each be a name that ALSO appears in this
SAME atom's own "entities" list above — never name an entity here that isn't also listed
there, and never invent a new entity just to complete a triple. predicate MUST be exactly one
of these 11 lowercase values — do not invent synonyms, do not use any other casing:
- uses: the subject employs/depends on the object as a tool or input (e.g. "the daemon" uses "sqlite-vec")
- depends_on: the subject requires the object to function (e.g. "the extraction stage" depends_on "Ollama")
- replaces: the subject was swapped in to replace the object (e.g. "mxbai-embed-large" replaces "nomic-embed-text-v2-moe")
- supersedes: the subject is a newer version/decision that supersedes the object (e.g. "v3 prompt" supersedes "v1 prompt")
- mentions: the subject references the object without a stronger relationship applying
- relates_to: a general association that doesn't fit a more specific predicate below
- part_of: the subject is a component/member of the object (e.g. "the extract stage" part_of "the distill pipeline")
- owned_by: the subject is owned/maintained by the object (e.g. "the deploy script" owned_by "Alice")
- assigned_to: a task/workitem subject is assigned to the object (e.g. "FEAT-402" assigned_to "the reviewer bot")
- created_by: the subject was authored/created by the object (e.g. "the migration" created_by "Bob")
- other: a real, meaningful relation that genuinely doesn't fit any predicate above
Possessor qualification (Graphiti pattern): resolve pronouns and possessives to the actual
named entity before writing subject/object — write "Alice" and "the deploy script", never
"her" and "it" or "her deploy script" as a single unresolved phrase.
Prefer omission over guessing: emit a relation ONLY when the source text states it directly.
When in doubt whether a relation genuinely holds, or whether it fits one of the 11 predicates,
leave "relations" empty (or omit it) for that atom rather than emitting a low-confidence guess.
Omit "relations" entirely (or leave it empty) when the atom asserts no clear relation between
two of its own named entities.

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

Examples (illustrative only, not exhaustive — the shape of these IS the spec: match their
length and richness for lesson/decision, and their brevity for fact/command/todo/event):

1. Input: "We need to pick a database for astramemory-local. It has to run fully offline on a laptop, no server process. What do you recommend?" / "For a local-first, single-process daemon, SQLite is the right choice over Postgres — no server to manage, ships as a single file. Postgres would force a separate server, breaking the local-first goal. sqlite-vec handles vector search in the same file, no separate vector DB needed." / "Good, also fyi we're already on Node 20." ->
{"atoms":[
  {"type":"decision","text":"Use SQLite via better-sqlite3, not Postgres, for astramemory-local's storage, and sqlite-vec (not a separate vector database) for similarity search — the daemon must run fully offline as a single local process with nothing to install or manage. Postgres would force a separate server, breaking the local-first promise; a standalone vector DB would add a second thing to keep running. Tradeoff: SQLite gives up Postgres's concurrent-writer scaling, which a single-node local daemon never needed anyway.","importance":0.8,"confidence":0.9,"entities":[{"name":"astramemory-local","kind":"project"},{"name":"SQLite","kind":"tech"},{"name":"Postgres","kind":"tech"},{"name":"sqlite-vec","kind":"tech"}],"relations":[{"subject":"astramemory-local","predicate":"uses","object":"SQLite","confidence":0.9},{"subject":"astramemory-local","predicate":"uses","object":"sqlite-vec","confidence":0.9},{"subject":"astramemory-local","predicate":"replaces","object":"Postgres","confidence":0.7}]},
  {"type":"fact","text":"The project runs on Node 20.","importance":0.4,"confidence":0.9}
]}

2. Input: "The reinstall step threw Access is denied when repointing current.json. Dug in — schtasks hadn't fully released its lock on the shim (launch.cjs) before we tried to overwrite it, since the old daemon process was still mid-restart. Added a poll-until-unlocked retry with a 2s timeout in materialize-release.ts before the overwrite." ->
{"atoms":[
  {"type":"lesson","text":"reinstall's materialize-release step threw 'Access is denied' when repointing current.json to the newly built release, because the previous daemon process hadn't fully released its file lock on the shim (launch.cjs) before the overwrite — schtasks' PT5M keepalive can still be mid-restart at that moment. Fixed in materialize-release.ts by adding a poll-until-unlocked retry (2s timeout) before overwriting the shim. Lesson: never overwrite a file a running service may still hold open without confirming the lock is released first.","importance":0.7,"confidence":0.9,"evidence":"threw Access is denied when repointing current.json","entities":[{"name":"materialize-release.ts","kind":"tech"},{"name":"launch.cjs","kind":"tech"}],"relations":[{"subject":"materialize-release.ts","predicate":"depends_on","object":"launch.cjs","confidence":0.6}]}
]}

3. Input: "Run \`git bisect start HEAD v1.2.0 -- src/\` to find which commit introduced the regression." / "Also TODO: add a rate limiter to the /ingest endpoint before we open registration." / "Also fyi we shipped the v0.9.2 patch release Tuesday." ->
{"atoms":[
  {"type":"command","text":"git bisect start HEAD v1.2.0 -- src/ — bisect a regression introduced somewhere between v1.2.0 and HEAD, scoped to src/.","importance":0.5,"confidence":0.8},
  {"type":"todo","text":"Add a rate limiter to the /ingest endpoint before opening registration.","importance":0.6,"confidence":0.8},
  {"type":"event","text":"Shipped the v0.9.2 patch release.","importance":0.4,"confidence":0.8}
]}

4. Input: "Users get logged out after 15 min even with a longer session configured. Found it — maxAge was set assuming seconds, matching our own session-length convention, but the cookie library actually expects milliseconds — silently 1000x too small. Fixed by replacing the bare number with a named FIFTEEN_MINUTES_MS constant at the call site. Also, switching topics, let's split CI's 'build' job into parallel 'lint' and 'test' jobs — they don't depend on each other and test alone takes several minutes." ->
{"atoms":[
  {"type":"lesson","text":"Users were logged out after 15 minutes even though the refresh-token cookie was configured for a much longer session, because maxAge was set assuming seconds (matching the app's own session-length convention) while the cookie library (a Set-Cookie wrapper) actually expects milliseconds — the value was silently 1000x too small. Fixed by replacing the raw number with a named MS_IN_15_MIN constant at the call site so the unit is explicit and reviewable, not inferred from a bare integer.","importance":0.7,"confidence":0.9},
  {"type":"decision","text":"Fix the refresh-token maxAge bug by introducing an explicit named millisecond constant (e.g. FIFTEEN_MINUTES_MS) at the cookie-config call site, rather than just correcting the raw number in place — a bare corrected integer would leave the next reader exposed to the exact same seconds-vs-milliseconds mistake, since the library's unit expectation is not visible at the call site without the name.","importance":0.6,"confidence":0.9},
  {"type":"decision","text":"Split the CI 'build' job into parallel 'lint' and 'test' jobs to cut wall-clock time, instead of leaving them sequential inside one job — lint and test have no dependency on each other's output, so running them as separate parallel jobs lets CI's runner scheduler execute both at once. Tradeoff: two job-startup overheads instead of one, but that's small next to the wall-clock savings on a repo where test alone takes several minutes.","importance":0.6,"confidence":0.8}
]}

5. Input: "hey" / "Hey! What can I help with?" / "just checking you're there" / "cool thanks that's all" ->
{"atoms":[]}

6. Input: "Set epsilon to 0.3." ... "Actually wait, 0.3 is too aggressive — in spot checks it let a couple heavily-corrected atoms outrank clearly better results. Use 0.1 instead, matching the ADR-010 default." ->
{"atoms":[
  {"type":"decision","text":"Set the usefulness-ranking epsilon component to 0.1, matching the ADR-010 default, rather than the initially proposed 0.3 — 0.3 let a handful of heavily-corrected atoms swing the fused ranking score enough to outrank clearly more relevant results in manual spot checks. 0.1 keeps the usefulness signal as a tie-breaker rather than letting it dominate raw relevance.","importance":0.7,"confidence":0.9},
  {"type":"lesson","text":"epsilon=0.3 in the usefulness-ranking fuse score was too aggressive — in manual spot checks it let a few heavily-corrected atoms outrank clearly more relevant results, because the usefulness term was swinging the fused score more than raw similarity should allow. Reverted to the ADR-010 default of 0.1 before this shipped anywhere.","importance":0.5,"confidence":0.8}
]}

7. NEGATIVE EXAMPLE — what NOT to produce. Input: "Before committing the refresh-token maxAge fix (the FIFTEEN_MINUTES_MS constant change), re-run the auth session-length test manually — unit tests don't cover the 15-minute boundary." ->
WRONG (contextless trivia — "the fix" names nothing, no rationale, meaningless to a future reader; this is the failure mode the richness and self-containment rules above exist to prevent):
{"type":"todo","text":"Re-verify the fix before committing and pushing.","importance":0.5,"confidence":0.6}
RIGHT (self-contained — names the exact fix and states why the check matters; still short/atomic, per the richness rule, because todo is not a lesson/decision):
{"type":"todo","text":"Re-run the auth session-length test manually before committing the refresh-token maxAge fix (FIFTEEN_MINUTES_MS constant) — unit tests don't cover the 15-min boundary.","importance":0.6,"confidence":0.8}`;
