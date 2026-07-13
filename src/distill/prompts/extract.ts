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
 * TODO SLICE-434: replace with the real conversational-profile prompt text
 * (mem0-pattern liberal extraction — 15-80 word self-contained sentences,
 * pronouns resolved, proper nouns preserved, relative dates grounded to an
 * explicit observation date — plus Graphiti-pattern possessor qualification
 * and a banned-abstractions negative list; design doc §3.2, AC-9/AC-10).
 * Falls back to the engineering v1 prompt verbatim until that content lands,
 * so `resolveExtractionPrompt` below is fully wired and testable before
 * SLICE-434 ships — never used to silently pass off engineering-profile
 * output as conversational; callers that need to detect "still pending" can
 * compare this constant's identity to EXTRACTION_SYSTEM_PROMPT.
 */
export const EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING = EXTRACTION_SYSTEM_PROMPT;

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
 * 3. `profile === 'conversational'` — the mem0/Graphiti-pattern profile.
 *    Currently returns the pending-marker constant above (SLICE-434 not yet
 *    landed), which is still byte-identical to the OLD (v1) engineering
 *    prompt — NOT the new v3 default. SLICE-434 owns replacing this with its
 *    own conversational-profile content; SLICE-433 deliberately does not
 *    touch it so the two prompt rewrites stay independently reviewable.
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
  if (profile === 'conversational') return EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_PENDING;
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
// entity kinds, precedence, or valid_at/invalid_at semantics; relation
// triples (FEAT-481) are explicitly out of scope here (SLICE-435).
// Every few-shot example below was rewritten or added for this version — the
// examples ARE the spec, so a lesson/decision example that stayed at v1's
// ~90-char shape would directly contradict the richness rule stated above
// it. Example 7 is a negative example (WRONG vs RIGHT) demonstrating the
// exact contextless-trivia failure mode this prompt exists to fix.
// Size note (review fix, 2026-07-13): this prompt is ~15.3k chars / ~3.8k
// tokens (chars/4) on its own — before the transcript chunk or the model's
// own output are counted. Local providers with a small default context
// window (Ollama's per-model default, observed 4096 for qwen2.5:7b) need
// num_ctx >= ~8k to fit prompt + chunk + output without silent truncation;
// src/providers/llm/ollama.ts now sizes num_ctx dynamically per call rather
// than requiring every caller to know this prompt's size up front.
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
      "entities": [{ "name": "<named thing mentioned>", "kind": "actor" | "team" | "org" | "project" | "product" | "workitem" | "decision" | "tech" | "tool" | "concept" | "event" | "other", "subtype": "human" | "ai", "valid_at": "<ISO-8601 date-time, only if the source text states one>", "invalid_at": "<ISO-8601 date-time, only if the source text states one>" }]
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
- Ground relative dates against an anchor stated in the transcript itself (a log timestamp, an
  explicit "as of 2026-07-10"). Resolve "yesterday" / "last week" / "this morning" to an absolute
  date when such an anchor exists. If no date anchor exists anywhere in the transcript, keep the
  original relative phrasing rather than inventing a date.

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
  {"type":"decision","text":"Use SQLite via better-sqlite3, not Postgres, for astramemory-local's storage, and sqlite-vec (not a separate vector database) for similarity search — the daemon must run fully offline as a single local process with nothing to install or manage. Postgres would force a separate server, breaking the local-first promise; a standalone vector DB would add a second thing to keep running. Tradeoff: SQLite gives up Postgres's concurrent-writer scaling, which a single-node local daemon never needed anyway.","importance":0.8,"confidence":0.9},
  {"type":"fact","text":"The project runs on Node 20.","importance":0.4,"confidence":0.9}
]}

2. Input: "The reinstall step threw Access is denied when repointing current.json. Dug in — schtasks hadn't fully released its lock on the shim (launch.cjs) before we tried to overwrite it, since the old daemon process was still mid-restart. Added a poll-until-unlocked retry with a 2s timeout in materialize-release.ts before the overwrite." ->
{"atoms":[
  {"type":"lesson","text":"reinstall's materialize-release step threw 'Access is denied' when repointing current.json to the newly built release, because the previous daemon process hadn't fully released its file lock on the shim (launch.cjs) before the overwrite — schtasks' PT5M keepalive can still be mid-restart at that moment. Fixed in materialize-release.ts by adding a poll-until-unlocked retry (2s timeout) before overwriting the shim. Lesson: never overwrite a file a running service may still hold open without confirming the lock is released first.","importance":0.7,"confidence":0.9,"evidence":"threw Access is denied when repointing current.json"}
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
