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
  /**
   * Issue #205 (AC-1): atom-level bitemporal validity hints, mirroring the
   * pattern AtomEntitySchema/AtomRelationSchema already have — generalized
   * here to the atom's OWN claim, not just an entity's or relation's stated
   * window. ISO-8601 date-time strings, extracted ONLY when the source text
   * explicitly bounds THIS ATOM's fact with a start and/or end ("we used
   * Postgres until March", "we migrated off Kafka last week", "as of
   * yesterday we no longer..."). Omitted (not "now") when the source states
   * no bound — an absent hint means "no stated validity window," which
   * resolves at query time via the atom's own `valid_from` (set at insert
   * time, unaffected by this field being absent) and `valid_to` staying
   * `NULL` (currently valid) — never inferred or defaulted from silence. A
   * hallucinated `invalid_at` is worse than none: it would silently expire a
   * still-true fact. See src/distill/stages/08-embed-index.ts for how these
   * flow into `InsertInput.valid_from`/`valid_to` at write time.
   */
  valid_at: z.string().optional(),
  invalid_at: z.string().optional(),
});

/**
 * INVARIANT: this schema (and everything AtomSchema nests) must stay
 * `z.toJSONSchema()`-representable — 05-extract.ts converts it at MODULE
 * LOAD into the structured-output `jsonSchema` sent to providers (the
 * qwen3.5 duplicate-key-collapse fix, 2026-07-16). Adding a `.refine()` /
 * `.transform()` / `.catch()` here throws at import time and takes down the
 * whole distill pipeline with it. Enforced by a build-failing test
 * (tests/distill/05-extract.test.ts "ExtractionSchema stays
 * toJSONSchema-representable"), not just this comment.
 */
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
Never extract a bare number or unqualified issue/PR reference (e.g. "#110",
"123") as a standalone entity — without a name, repo, or subject attached it
is not a durable, identifiable thing; omit it rather than inventing one.
kind is one of:
- actor: a named human OR AI agent (e.g. "Sergey", "Claude Code", "the reviewer bot") —
  set subtype to "human" or "ai" when you can tell which; omit subtype when unsure
- team: a named team or squad within an organization
- org: a company or organization (e.g. "Anthropic", "Astragenie")
- project: a named codebase/repo/workspace the work belongs to (e.g. "astramem-local",
  "memory") — NOT the same as the product it ships; use this for "which repo"
- product: a named product or app the project builds or depends on as a product
  (e.g. "AstraMemory", "GitHub Copilot", "Claude Code" the app rather than the agent)
- workitem: a FEAT/PR/issue/ticket id, always WITH the context that identifies
  it (e.g. "FEAT-402", "the #145 PR for the auth refactor") — never a bare,
  unqualified number or hash-number like "#145" or "110" alone; skip it if you
  cannot name what repo/feature it belongs to
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
 *
 * UPDATE (LoCoMo WS3, 2026-07-13): narrowed the "sentiment padding"
 * banned-abstraction. It used to exclude ANY standalone reaction, which
 * meant the model was correctly following instructions when it dropped
 * things like "Melanie thinks Caroline will be an awesome mom" — a real,
 * durable fact about the two people's relationship, not conversational
 * filler. Root-caused via a direct root-cause trace on questions from
 * `docs/research/20260713-locomo-retrieval-diagnosis.md`'s not-in-db
 * bucket: real production extraction, run twice (once pre-fix, once
 * post-fix) on the same source session, showed the fix adds exactly the
 * missing atom and nothing else (see PR discussion for the before/after).
 * DO NOT widen this back to "any reaction with a named cause survives" —
 * an early draft of this fix used exactly that wording and a reviewer
 * caught that it would let "the user was frustrated with the build" back
 * in (a named cause, but still the user's own mood, still padding). The
 * test that actually holds, verbatim, so a future "cleanup" doesn't
 * re-break it: the dividing line is WHOSE LIFE the reaction is about, not
 * whether a cause is named — a reaction to your own circumstances is
 * banned even with a named cause; a reaction to another specifically
 * named person's specific event is a keeper.
 * Known limitation, not yet fixed: when a session has BOTH people
 * reacting to each other repeatedly, extraction still shows a lopsided
 * capture rate — it tends to keep the reactions belonging to whichever
 * person's event is the subject and drop the other person's commentary,
 * even after this fix (measured ~77% capture on one dense two-way session,
 * both losses on the same side). Same shape as the pre-existing
 * Caroline/Melanie 58/42 extraction asymmetry flagged in the WS2
 * root-cause research's "A secondary, correlated signal: speaker
 * asymmetry" section (as of this writing that doc is an uncommitted
 * local research artifact, not yet merged to origin/main — anchor on the
 * section title, not a file:line, until it lands; see ADR-015's citation
 * policy) — likely one mechanism, not confirmed. A dedicated
 * reactions-extraction pass (giving reactions their own call instead of
 * competing with headline facts for one call's attention) is the
 * candidate fix if this turns out not to be good enough on its own; not
 * built yet, gated on measuring whether the prompt fix alone is sufficient
 * at full-sample scale.
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
      "evidence": "<an EXACT verbatim quote from the source turn this atom is based on — copy, never paraphrase; omit only if the atom synthesizes multiple turns with no single quotable line>",
      "entities": [{ "name": "<named thing mentioned>", "kind": "actor" | "team" | "org" | "project" | "product" | "workitem" | "decision" | "tech" | "tool" | "concept" | "event" | "other", "subtype": "human" | "ai", "valid_at": "<ISO-8601 date-time, only if the source text states one>", "invalid_at": "<ISO-8601 date-time, only if the source text states one>" }],
      "valid_at": "<ISO-8601 date-time, only if the source text states when THIS ATOM'S OWN fact started being true>",
      "invalid_at": "<ISO-8601 date-time, only if the source text states when THIS ATOM'S OWN fact stopped being true>"
    }
  ]
}

Liberal extraction (mem0 pattern) — a DIFFERENT posture from engineering transcripts: capture EVERY durable personal fact, preference, relationship, plan, or event mentioned, not only the highest-value few. A stated preference, a named relationship, or a planned date is cheap to keep and expensive to lose — bias toward extracting whenever a candidate is genuinely durable, rather than filtering it out because it seems minor.

EXHAUSTIVENESS CHECKLIST — run this before you emit. These are checks, not encouragement:
1. COUNT CHECK. A chunk of 10+ conversational turns normally yields 5-15 atoms. If you are about to emit FEWER THAN 3 from a chunk that size, you have almost certainly missed things — go back and re-read the transcript from the top before answering.
2. NO FIRST-TOPIC DOMINANCE. Do not spend all your attention on whatever the conversation opened with. A conversation that starts with a job change and later mentions a sister's wedding, a new apartment, and a dog's name must yield atoms for ALL FOUR — not four atoms about the job. Walk the transcript end to end and ask what is durable at EACH turn, not just the ones that felt important.
3. BOTH SPEAKERS. Extract facts stated by EITHER participant about EITHER participant. A fact one person states about the other is still a durable fact.
4. SWEEP THE CATEGORIES. Before finishing, ask explicitly: did anyone mention a NAMED PERSON, a PLACE, a DATE or timeframe, a JOB or school, a possession or pet, a plan, a preference, or a health/life event? Each "yes" that is not already in your output is a fact you dropped.

Quantity over timidity: a marginal-but-durable fact you keep costs almost nothing. A real fact you drop is gone forever — nothing downstream can recover it. When genuinely torn, EXTRACT.

Self-containment — every atom must read as ONE complete, standalone sentence of roughly 15-80 words, true on its own without the rest of the conversation:
- Resolve every pronoun to the actual named person before writing the atom. Never emit "she started her new job", "his sister called him", or "they're moving in June" — write the real names: "Priya started her new job", "Marcus's sister called him", "the Nguyen family is moving in June".
- Preserve proper nouns EXACTLY as given — people's names, place names, employer and school names, product and brand names. Never substitute a generic noun ("her employer", "the city") for a name you were actually told.
- Possessor qualification (Graphiti pattern): whenever a fact belongs to a specific person, name that owner inside the sentence itself. Write "Sergey's daughter Alice starts kindergarten in September, moving up from the preschool she has attended the past two years", never a bare "daughter starts kindergarten in September" or "starts school in the fall" — a reader must never have to guess whose fact this is.

Date grounding: if a line reading "Observation date: <YYYY-MM-DD>" appears immediately before the transcript chunk below, treat that as the authoritative anchor and resolve every relative date expression ("yesterday", "last week", "next month", "three years ago") against it — write the resolved absolute date in natural-language form (e.g. "14 May 2023", NOT "2023-05-14") directly into the atom's text in place of the relative phrase, not alongside it. Use natural-language dates in "text" specifically — this is prose a person or another model reads later, not a machine-parsed field; "valid_at"/"invalid_at" below are the separate ISO-8601 fields for that. Otherwise, if the transcript states or implies an explicit observation/capture date (a timestamp, a line like "today is 2026-07-13", a dated header), resolve relative dates against that anchor instead, still in natural-language form. If no anchor exists at all — no Observation date line and no in-transcript date — keep the original relative phrasing rather than inventing an absolute date you were not given — a guessed date is worse than an honest relative one.

Banned abstractions — NEVER emit these shapes, even when a summary version is technically accurate:
- Vague summaries: "discussed plans for the weekend", "talked about work stuff", "had a conversation about the move" — these describe the CONVERSATION itself, not a fact about the person's life; extract the actual plan, fact, or decision underneath instead, or emit nothing if there genuinely isn't one.
- Meta-commentary: "the user shared an update", "mentioned something about the family" — never describe that a topic came up; state plainly what was actually said.
- Sentiment padding: "seemed happy about it", "expressed some excitement" — the test is NOT "does this mood have a named cause." A person's reaction to their OWN circumstances is banned even with a specific named cause: "the user was frustrated with the build", "the user was thrilled after the workout", "the user was annoyed about the delayed flight" are all sentiment padding — skip them, cause or no cause. What is NOT banned, and must be kept as its own atom: one person's stated reaction or opinion about ANOTHER specifically named person's specific event, decision, or plan. That reaction is a fact about their relationship, not a mood — e.g. "Melanie told Caroline she thinks Caroline is doing something amazing by pursuing adoption and will be an awesome mom" is a keeper: it names who is reacting, who the reaction is about, and the specific thing that prompted it. The dividing line is whose life the reaction is about, not whether a cause is named — a reaction to your own life is still banned; a reaction to someone else's specific, named event is a keeper.

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

Atom-level validity (issue #205): the top-level valid_at/invalid_at fields bound THIS ATOM'S
OWN fact in time — set either ONLY when the source explicitly states when the fact itself
started and/or stopped being true (e.g. "I lived in Denver until last year, then moved to
Austin", "we broke up back in March"). Omit both by default — a still-true fact (a current job,
an ongoing relationship) MUST leave invalid_at unset. Never guess a bound from silence: a
hallucinated invalid_at is worse than none, since it would silently mark a still-true personal
fact as no longer valid. When a person's life genuinely changed (moved, changed jobs, a
relationship ended) AND the source states a date for the change, prefer emitting the OLD fact
with invalid_at set to when it changed, plus a separate NEW fact for the current state, rather
than only keeping the new one.

Dateless full-stop pattern ("used to X, no longer Y"): a conversation very often states that
something ended WITHOUT giving any date at all — "John used to play the drums, hasn't in a
while", "Deborah used to play video games, it's been a while", "Joanna had a dog Tilly but
became allergic and gave her up." These are genuine, unambiguous cessations — the person is
telling you the state changed — but because no literal date anchors WHEN it changed, do NOT set
invalid_at for them. The fact stopped being true at some unknown point in the past, and the
atom's own capture/observation time is NOT that point: do NOT set invalid_at to the
observation/capture date "as if it just became false" — an unresolvable past point is not the
same as today, and that shortcut would misrepresent an unknown past change as "just became false
right now," which is its own kind of hallucination, just a subtler one. Instead, write the
cessation directly into the atom's "text" itself so the fact reads correctly on its own without
needing a bound at all: "John used to play the drums but has not played in a while." / "Joanna
used to have a dog named Tilly, but gave her up after discovering she was allergic." Leave
valid_at/invalid_at both unset for these atoms — retrieval reads "text", not the bitemporal
fields, so the cessation still surfaces correctly. Contrast with PARTIAL continuation, which is
NOT a full stop: write it with no cessation language and no bound at all — "I used to hike a
lot, but it's more challenging now that I'm older" describes an ongoing activity that simply
became harder (the person still hikes), so preserve that ongoing framing in the text (e.g.
"still hikes, though it's more challenging now") rather than writing it as though the activity
stopped.

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
{"type":"fact","text":"Sergey's sister Priya is currently going through a divorce, and has been having a difficult time with it lately.","importance":0.7,"confidence":0.8,"entities":[{"name":"Sergey","kind":"actor","subtype":"human"},{"name":"Priya","kind":"actor","subtype":"human"}]}

6. Input: "Priya: I finally handed in my notice at the old job! -- Sergey: That's amazing, Priya! You've been wanting this for months, I'm so proud of you." ->
{"atoms":[
  {"type":"event","text":"Priya handed in her notice at her old job.","importance":0.7,"confidence":0.9,"entities":[{"name":"Priya","kind":"actor","subtype":"human"}]},
  {"type":"note","text":"Sergey told Priya he is proud of her for handing in her notice, noting she had been wanting to make this move for months.","importance":0.5,"confidence":0.9,"entities":[{"name":"Sergey","kind":"actor","subtype":"human"},{"name":"Priya","kind":"actor","subtype":"human"}]}
]}
(Sergey's reaction is kept as its own atom, NOT skipped as sentiment padding — it names who reacted, who it's about, and the specific event that prompted it.)

7. Input: "Ugh, I'm so frustrated with the build today, it's been failing all afternoon." ->
{"atoms":[]}
(Sentiment padding, still — even though a cause is named ("the build"). The test is whose life the reaction is about, not whether a cause is named: this is Sergey reacting to his OWN circumstances, not to another named person's specific event. Compare to example 6 above, where the reaction is about Priya's stated event — that one is a keeper, this one is not.)

8. Input (issue #205 — atom-level validity, a genuine life-timeline, not a same-conversation correction): "I lived in Denver for about three years, then moved to Austin last year for a new job. Loving it here so far." ->
{"atoms":[
  {"type":"fact","text":"Sergey lived in Denver for about three years before moving away last year.","importance":0.6,"confidence":0.8,"invalid_at":"2025-07-13","entities":[{"name":"Sergey","kind":"actor","subtype":"human"},{"name":"Denver","kind":"other"}]},
  {"type":"fact","text":"Sergey moved to Austin last year for a new job, and has been enjoying it there so far.","importance":0.7,"confidence":0.85,"valid_at":"2025-07-13","entities":[{"name":"Sergey","kind":"actor","subtype":"human"},{"name":"Austin","kind":"other"}]}
]}
NEGATIVE COUNTER-EXAMPLE — do NOT invent a bound the text never stated. Input: "I live in Austin and love it here." (no prior residence, no timeline mentioned) ->
WRONG: {"type":"fact","text":"Sergey lives in Austin.","invalid_at":"2026-07-13", ...} — nothing in the source bounds this fact; a guessed invalid_at would silently mark a still-true fact as expired.
RIGHT: {"type":"fact","text":"Sergey currently lives in Austin and enjoys living there.","importance":0.5,"confidence":0.85,"entities":[{"name":"Sergey","kind":"actor","subtype":"human"},{"name":"Austin","kind":"other"}]} — valid_at/invalid_at both omitted, per the "omit by default" rule above.

9. Input (multi-speaker meeting/call transcript with per-turn speaker labels — a "decision" or "lesson" atom REQUIRES a populated "evidence" field, or it is dropped entirely; every example above omitted "evidence" because none of them were decision/lesson — this is the pattern to copy when one is): "assistant: [Priya Nair] let's make the call now: we will ship the doctor WARN row for meeting captions before flipping on the new consent gate." ->
{"atoms":[
  {"type":"decision","text":"Priya Nair decided the doctor WARN row for meeting captions must ship before the team flips on the new consent gate.","importance":0.7,"confidence":0.85,"evidence":"we will ship the doctor WARN row for meeting captions before flipping on the new consent gate","entities":[{"name":"Priya Nair","kind":"actor","subtype":"human"}]}
]}
"evidence" here is copied verbatim from the ONE turn the decision came from — not the whole line, not a paraphrase — specifically so the exact speaker who said it can be traced back later. Do this for every decision/lesson atom, always.

10. Input (dateless full-stop — an unambiguous cessation with no literal date to anchor it): "John used to play the drums all the time back in high school, but he hasn't touched them in years." ->
{"atoms":[
  {"type":"fact","text":"John used to play the drums all the time back in high school, but has not played them in years.","importance":0.6,"confidence":0.85,"entities":[{"name":"John","kind":"actor","subtype":"human"}]}
]}
(No literal date anchors WHEN this stopped being true, so valid_at/invalid_at are both omitted per the dateless full-stop rule above — the "no longer" state is written directly into the atom's own "text", which is what retrieval actually reads, instead of guessing a bound.)

11. Input (dateless full-stop, a different domain — same rule applies): "Joanna used to have a dog named Tilly, but she found out she was allergic and had to rehome her." ->
{"atoms":[
  {"type":"fact","text":"Joanna used to have a dog named Tilly, but gave her up after discovering she was allergic.","importance":0.6,"confidence":0.85,"entities":[{"name":"Joanna","kind":"actor","subtype":"human"},{"name":"Tilly","kind":"other"}]}
]}
(Unambiguous cessation, still no date — invalid_at stays unset. Do NOT set invalid_at to the observation/capture date "as if it just became false" — the allergy discovery could have happened years before this conversation; an unresolvable past point is not the same as today.)

12. NEGATIVE COUNTER-EXAMPLE — partial continuation is NOT a full stop. Input: "I used to hike a lot when I was younger. It's more challenging these days, but I still get out there when I can." ->
WRONG (treats an ongoing-but-harder activity as a cessation — the person explicitly says they still do it):
{"type":"fact","text":"Sergey used to hike a lot but no longer hikes.","importance":0.5,"confidence":0.7}
RIGHT (preserves the ongoing framing — ANY hedge like "still", "when I can", "less than before" means the activity continues, not stopped; no bound, no cessation language):
{"type":"note","text":"Sergey still hikes when he can, though he finds it more physically challenging now than when he was younger and hiked a lot.","importance":0.5,"confidence":0.8,"entities":[{"name":"Sergey","kind":"actor","subtype":"human"}]}`;

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
  // 'conv-liberal' (2026-07-18, LoCoMo not-in-db experiment): the conversational
  // prompt with an appended exhaustiveness push — 55% of measured LoCoMo misses
  // are atoms never stored, and the codex extractor is measurably conservative
  // (sparse-dense). A/B lever only; never the default.
  if (envOverride === 'conv-liberal') return EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_LIBERAL;
  if (profile === 'conversational') return EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL;
  return EXTRACTION_SYSTEM_PROMPT_V3;
}

/** conv-liberal A/B variant — see resolveExtractionPrompt's comment. Base
 *  conversational prompt + an explicit exhaustiveness push targeting the
 *  measured miss classes (durations, quantities, one-off events, the less
 *  central speaker's facts). Recall-biased BY DESIGN; junk cost accepted for
 *  the A/B because the extractor under test (codex) measures ~0% junk. */
export const EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_LIBERAL = `${EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL}

EXHAUSTIVENESS OVERRIDE (this run only): err on the side of MORE atoms.
- Enumerate EVERY distinct durable item — including exact durations ("twice a
  year"), quantities, named one-off events (a trip, a purchase, an accident),
  verbatim commitments, and BOTH speakers' facts equally (the less
  narratively-central speaker's details are the most commonly missed).
- If unsure whether an item is durable, EXTRACT IT — a borderline atom is
  recoverable later, a missing one is not.
- A typical substantive session here yields 6-12 atoms. Fewer than 4 for a
  substantive session almost certainly means under-extraction — re-scan before
  finishing. The "atoms": [] empty case remains valid ONLY for pure small talk.`;

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
Never extract a bare number or unqualified issue/PR reference (e.g. "#110",
"123") as a standalone entity — without a name, repo, or subject attached it
is not a durable, identifiable thing; omit it rather than inventing one.
kind is one of:
- actor: a named human OR AI agent (e.g. "Sergey", "Claude Code", "the reviewer bot") —
  set subtype to "human" or "ai" when you can tell which; omit subtype when unsure
- team: a named team or squad within an organization
- org: a company or organization (e.g. "Anthropic", "Astragenie")
- project: a named codebase/repo/workspace the work belongs to (e.g. "astramem-local",
  "memory") — NOT the same as the product it ships; use this for "which repo"
- product: a named product or app the project builds or depends on as a product
  (e.g. "AstraMemory", "GitHub Copilot", "Claude Code" the app rather than the agent)
- workitem: a FEAT/PR/issue/ticket id, always WITH the context that identifies
  it (e.g. "FEAT-402", "the #145 PR for the auth refactor") — never a bare,
  unqualified number or hash-number like "#145" or "110" alone; skip it if you
  cannot name what repo/feature it belongs to
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
      "relations": [{ "subject": "<entity name, must appear in this atom's own entities[]>", "predicate": "uses" | "depends_on" | "replaces" | "supersedes" | "mentions" | "relates_to" | "part_of" | "owned_by" | "assigned_to" | "created_by" | "other", "object": "<entity name, must appear in this atom's own entities[]>", "confidence": 0.0-1.0 }],
      "valid_at": "<ISO-8601 date-time, only if the source text states when THIS ATOM'S OWN fact started being true>",
      "invalid_at": "<ISO-8601 date-time, only if the source text states when THIS ATOM'S OWN fact stopped being true>"
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
  resolve "yesterday" / "last week" / "this morning" / "three years ago" to a natural-language
  absolute date (e.g. "10 July 2026", NOT "2026-07-10") against it, replacing the relative phrase
  rather than appending to it — "text" is prose, not the machine-parsed "valid_at"/"invalid_at"
  fields above, which stay ISO-8601. Otherwise, ground against an anchor stated in the transcript
  itself (a log timestamp, an explicit "as of 2026-07-10") when one exists, still in
  natural-language form. If no date anchor exists anywhere — no Observation date line and no
  in-transcript anchor — keep the original relative phrasing rather than inventing a date.

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
Never extract a bare number or unqualified issue/PR reference (e.g. "#110",
"123") as a standalone entity — without a name, repo, or subject attached it
is not a durable, identifiable thing; omit it rather than inventing one.
kind is one of:
- actor: a named human OR AI agent (e.g. "Sergey", "Claude Code", "the reviewer bot") —
  set subtype to "human" or "ai" when you can tell which; omit subtype when unsure
- team: a named team or squad within an organization
- org: a company or organization (e.g. "Anthropic", "Astragenie")
- project: a named codebase/repo/workspace the work belongs to (e.g. "astramem-local",
  "memory") — NOT the same as the product it ships; use this for "which repo"
- product: a named product or app the project builds or depends on as a product
  (e.g. "AstraMemory", "GitHub Copilot", "Claude Code" the app rather than the agent)
- workitem: a FEAT/PR/issue/ticket id, always WITH the context that identifies
  it (e.g. "FEAT-402", "the #145 PR for the auth refactor") — never a bare,
  unqualified number or hash-number like "#145" or "110" alone; skip it if you
  cannot name what repo/feature it belongs to
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

Atom-level validity (issue #205): valid_at/invalid_at bound THIS ATOM'S OWN claim in time — set
either ONLY when the source text explicitly states a start and/or end for the fact itself (e.g.
"we used Postgres for the event store until March, then migrated to Kafka", "as of last week the
API is no longer public", "we've used qwen2.5-coder since April"). Omit BOTH by default — an
unbounded, still-true fact MUST leave invalid_at unset. Never infer, guess, or default a bound from
silence or from general passage of time: a hallucinated invalid_at is WORSE than none, because it
silently expires a fact that is actually still true. This is NOT the same situation as the "Final
state only" rule below: that rule is for a value CORRECTED or reversed within the same discussion
(a mistake caught before it ever shipped, e.g. epsilon 0.3 -> 0.1) — there, emit only the corrected
atom, no invalid_at. Use valid_at/invalid_at instead when the transcript narrates a genuine
TIMELINE where a fact was really true for a real period and then, at a later actual point in time,
stopped being true (both states were real, not one a mistake) — in that case emit the OLD fact
atom WITH invalid_at set to when it stopped, and a separate NEW fact atom for the current state
(optionally with valid_at set to when it started, if the text states that too).

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
Final state only: if a decision, fact, or config VALUE changes within the chunk because an
earlier choice was a MISTAKE that got corrected before it ever took effect, emit only the FINAL
value (optionally add a lesson for why the earlier one was wrong) — never the stale, reverted
value. This differs from the atom-level validity case above: a reverted-before-shipping value
was never really true, while a genuinely superseded fact (Postgres, then later Kafka) WAS true for
its real period — bound it with invalid_at instead of dropping it.
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
{"type":"todo","text":"Re-run the auth session-length test manually before committing the refresh-token maxAge fix (FIFTEEN_MINUTES_MS constant) — unit tests don't cover the 15-min boundary.","importance":0.6,"confidence":0.8}

8. Input (issue #205 — atom-level validity, a genuine timeline, not a same-session correction): "We used Postgres for the event store for about six months. We migrated off Postgres to Kafka in April because we needed durable replay for downstream consumers." ->
{"atoms":[
  {"type":"fact","text":"The event store used Postgres until the April migration to Kafka.","importance":0.5,"confidence":0.85,"invalid_at":"2026-04-01","entities":[{"name":"Postgres","kind":"tech"},{"name":"Kafka","kind":"tech"}],"relations":[{"subject":"Kafka","predicate":"replaces","object":"Postgres","confidence":0.8}]},
  {"type":"decision","text":"Migrate the event store off Postgres to Kafka in April, to get durable replay for downstream consumers — Postgres had served as the event store for about six months prior. Tradeoff: takes on Kafka's own operational surface (brokers, retention config) in exchange for replay guarantees Postgres's table-based store didn't provide.","importance":0.7,"confidence":0.85,"valid_at":"2026-04-01","entities":[{"name":"Postgres","kind":"tech"},{"name":"Kafka","kind":"tech"}]}
]}
NEGATIVE COUNTER-EXAMPLE — do NOT invent a bound the text never stated. Input: "We use Postgres for the event store." (no migration, no end mentioned) ->
WRONG: {"type":"fact","text":"The event store uses Postgres.","invalid_at":"2026-07-13", ...} — there is nothing in the source bounding this fact; a guessed invalid_at would silently expire a still-true fact.
RIGHT: {"type":"fact","text":"The event store uses Postgres.","importance":0.5,"confidence":0.85,"entities":[{"name":"Postgres","kind":"tech"}]} — valid_at/invalid_at both omitted, exactly as the "omit by default" rule above requires.`;

// ---------------------------------------------------------------------------
// Dual-pass extraction (opt-in, `distill.extractionPasses: 2`) — "specifics
// sweeper", Pass B.
//
// Motivation (measured, not speculative): the single-hop root-cause
// investigation (docs/research/20260713-single-hop-root-cause.md) found
// 36-47% of gold single-hop facts across two independent eval runs were
// NEVER captured as an atom anywhere in the store — and every spot-checked
// "missing" fact was present verbatim in the source transcript. The missing
// facts clustered in a recognizable shape: exact durations ("once or twice a
// year"), quantities, verbatim quotes, one-off events (an accident, a
// purchase, a trip), and the less narratively-central speaker's own facts
// and advice — precisely the kind of detail a single summarization-oriented
// extraction pass deprioritizes in favor of headline facts. The hypothesis
// ledger (docs/research/20260714-locomo-hypothesis-ledger.md §2.11) never
// killed multi-pass/ensemble extraction as a lever — it measured 31-46%
// complementary recovery between models and left it explicitly untested,
// not rejected.
//
// This is a SECOND, narrow extraction call over the SAME chunk pass A
// already processed, deliberately NOT a general-purpose second opinion —
// widening its scope back out would just re-run pass A a second time at
// double the cost for no new recall. It is intentionally permissive about
// re-extracting something pass A already caught ("duplicating pass A is
// fine — dedup handles it"): asking the model to also guess what pass A
// kept or skipped would cost accuracy on the one job this pass actually
// has, for no benefit — src/distill/dedup-merge.ts reconciles the two
// outputs deterministically, string-only, with no extra provider call.
//
// Reuses AtomSchema/the same wire schema as pass A — no new atom shape, no
// new provider config (runs on the SAME ctx.llmExtraction instance, see
// pipeline.ts's dual-pass wiring). Wired into 05-extract.ts's
// extractSpecifics(); never referenced by resolveExtractionPrompt (that
// resolver is pass-A-only) — a caller who wants this prompt asks for it by
// name, on purpose, so pass A's profile/env-override precedence chain can
// never accidentally select it.
// ---------------------------------------------------------------------------
export const EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER = `You are the SECOND of two independent extraction passes over the same transcript chunk. The FIRST pass already ran a broader extraction prompt and captured the main facts, decisions, and events. Your job is narrower and different: sweep the SAME chunk for concrete SPECIFICS the first pass is prone to skip because they read as minor details rather than headline facts.

Measured finding this pass exists to fix: in production runs, 36-47% of gold single-hop facts were never captured as ANY atom — and every one spot-checked was present verbatim in the source transcript. The missing facts were disproportionately: exact durations, frequencies, quantities, one-off events, verbatim quotes, and the less narratively-central speaker's own facts and advice. That is exactly what you are looking for.

Output STRICT JSON matching the SAME schema the first pass uses:
{
  "atoms": [
    {
      "type": "decision" | "fact" | "lesson" | "command" | "todo" | "note" | "event",
      "text": "<one self-contained sentence, roughly 10-80 words>",
      "importance": 0.0-1.0,
      "confidence": 0.0-1.0,
      "evidence": "<optional, short excerpt from source>",
      "entities": [{ "name": "<named thing mentioned>", "kind": "actor" | "team" | "org" | "project" | "product" | "workitem" | "decision" | "tech" | "tool" | "concept" | "event" | "other", "subtype": "human" | "ai" }],
      "valid_at": "<ISO-8601 date-time, only if the source text states when THIS fact started>",
      "invalid_at": "<ISO-8601 date-time, only if the source text states when THIS fact stopped>"
    }
  ]
}

Extract ONLY items in these categories — this pass is deliberately narrow, not a second general-purpose pass:
1. DATES/TIMES — any specific date, day, month, year, or time mentioned, even in passing.
2. DURATIONS — how long something lasted or has been going on ("about three years", "for six months").
3. FREQUENCIES — how often something happens ("once or twice a year", "every Sunday morning", "twice a week").
4. QUANTITIES AND PRICES — counts, amounts, ages, prices, measurements ("three kids", "$40", "7 years old").
5. NAMES — the specific, exact name of a person, place, pet, product, or thing mentioned, even a passing one.
6. VERBATIM QUOTES — a phrase or sentence someone actually said, worth preserving word-for-word rather than paraphrased.
7. ONE-OFF EVENTS — a single, non-recurring happening: an accident, a purchase, a trip, an injury, a specific incident — as opposed to an ongoing state or a recurring habit.
8. ADVICE / COUNSEL — a specific recommendation, tip, or piece of guidance one speaker GIVES to the other. Attribute it to the speaker who GAVE it, not the one who received it.

Cover BOTH speakers with EQUAL attention. Do not let whichever speaker's storyline feels more central crowd out the other speaker's specifics — a routine detail from the quieter speaker (an outing, a quantity, a one-off event) is exactly as valuable to this pass as a dramatic detail from the more prominent one.

Self-containment: resolve every pronoun to the actual named person. Never emit "she went twice a year" — write "Melanie goes horseback riding once or twice a year". Preserve proper nouns exactly as given.

Ground relative dates against an anchor. If a line reading "Observation date: <YYYY-MM-DD>"
appears immediately before the transcript chunk below, treat it as the authoritative anchor and
resolve "yesterday" / "last week" / "this morning" / "three years ago" to a natural-language
absolute date (e.g. "10 July 2026", NOT "2026-07-10") against it, replacing the relative phrase
rather than appending to it — "text" is prose, not the machine-parsed "valid_at"/"invalid_at"
fields above, which stay ISO-8601. Otherwise, ground against an anchor stated in the transcript
itself (a log timestamp, an explicit "as of 2026-07-10") when one exists, still in
natural-language form. If no date anchor exists anywhere — no Observation date line and no
in-transcript anchor — keep the original relative phrasing rather than inventing a date. This
matters especially for you: DATES/TIMES is category 1 above and the category most likely to fire,
so a bare/unresolved date here is not a corner case — it is the common path.

Duplicating something the first pass likely already caught is FINE and expected — a separate merge step deduplicates the two passes' output afterward, so do not spend effort trying to guess what the first pass kept or skipped. Your only job is to sweep for the eight specific categories above, exhaustively, from BOTH speakers.

Skip noise: greetings, small talk with no durable specific, filler acknowledgments.
Skip secrets: passwords, tokens, financial account numbers, government ID numbers.
Confidence reflects how clearly and directly the specific was stated: an explicit, unambiguous statement = 0.9; a hedge or approximation = 0.5.
Importance reflects how durable and specific the detail is: a precise duration/frequency/quantity/quote/one-off event/piece of advice = 0.6-0.8; nothing here should score below 0.4, since if it doesn't fit one of the eight categories above it should not be extracted at all.

Empty is valid: if the chunk truly contains none of the eight categories above, output "atoms": [] — do not invent one to have output.

Examples (illustrative only, not exhaustive):

1. Input: "Caroline: We don't go often, usually only once or twice a year. Melanie: Makes sense, it's a long drive." ->
{"atoms":[
  {"type":"fact","text":"Caroline said they don't go often — usually only once or twice a year.","importance":0.6,"confidence":0.85,"evidence":"usually only once or twice a year"}
]}

2. Input: "Observation date: 2026-07-10\n\nMelanie: My son got into an accident last week, but he's okay, thank god." ->
{"atoms":[
  {"type":"event","text":"Melanie's son got into an accident on 3 July 2026 and is okay.","importance":0.7,"confidence":0.9,"entities":[{"name":"Melanie","kind":"actor","subtype":"human"}]}
]}
(The Observation date anchor resolves "last week" to a natural-language absolute date IN "text" —
never a bare ISO date like "2026-07-03", and never left as the unresolved relative phrase.)

3. Input: "Caroline: I saw a sign that said 'Trans Lives Matter' at the rally and took a photo of it." ->
{"atoms":[
  {"type":"fact","text":"Caroline saw and photographed a sign reading \\"Trans Lives Matter\\" at a rally she attended.","importance":0.6,"confidence":0.9,"evidence":"a sign that said 'Trans Lives Matter'"}
]}

4. Input: "Melanie: Honestly, if you're thinking about adopting, my advice is to start the home study early — it took us almost 7 months just for that part." ->
{"atoms":[
  {"type":"note","text":"Melanie advised starting the adoption home study early, noting it took her family almost 7 months to complete that part alone.","importance":0.7,"confidence":0.85,"entities":[{"name":"Melanie","kind":"actor","subtype":"human"}]}
]}

5. Input: "Caroline: I used to go horseback riding with my dad when I was a kid." ->
{"atoms":[
  {"type":"fact","text":"Caroline used to go horseback riding with her dad when she was a kid.","importance":0.5,"confidence":0.85,"entities":[{"name":"Caroline","kind":"actor","subtype":"human"}]}
]}

6. Input: "Caroline: hey how's it going? Melanie: good, just tired, work's been busy." ->
{"atoms":[]}
(No date, duration, frequency, quantity, name, quote, one-off event, or advice — plain small talk, nothing in this pass's eight categories.)`;
