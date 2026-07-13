/**
 * Schema-anchored redaction for the ingest-spool WRITE path (fast-follow,
 * 2026-07-13 — third design of this fix, see history below).
 *
 * `writeToSpool` (src/ingest/spool.ts) must redact secrets in an envelope
 * BEFORE the bytes hit disk, but it cannot simply redact every string value
 * it finds: `CanonicalIngestSchema` (src/server/routes/ingest.ts) defines
 * several open, unconstrained `z.string()` fields — `session_id` above
 * all — that are load-bearing IDENTIFIERS the daemon uses for correlation
 * (session upsert primary key, transcript foreign key, distill job
 * payload, redaction-log keys, structured logging — see ingest.ts for the
 * call sites). `session_id` is shaped `proxy-${randomUUID()}` on every real
 * proxy capture, which is exactly the kind of high-entropy string
 * `redactIfEnabled`'s entropy detector flags. A naive "redact every string"
 * walk turns every live session's identity into a placeholder, silently —
 * the schema still validates (a non-empty string is still a non-empty
 * string), so `ingestCanonicalTranscript` upserts a session keyed on
 * garbage with no error anywhere. Quarantined files (src/ingest/spool.ts
 * `sweepQuarantineRedaction`) don't have this problem — nothing reads a
 * dead file, so redacting everything there is free. Spooled files are
 * alive; this module exists because that distinction matters.
 *
 * ADR-015 angle: every enum, regex-format, and datetime-format field in
 * this schema is SELF-PROTECTING — if one of those gets redacted into a
 * placeholder anyway, `CanonicalIngestSchema.safeParse` at drain time
 * (src/ingest/spool-drain.ts) rejects the placeholder and the whole
 * envelope quarantines LOUDLY, the exact ADR-015 rule 4 distinction (an
 * infrastructure/validation failure must never collapse into a valid
 * domain value). The truly dangerous fields are the open, unconstrained
 * `z.string()`/`z.string().nullable()` ones with no format check: a
 * redacted placeholder there is STILL a syntactically valid value, so
 * nothing downstream ever notices. That's the set this module protects.
 *
 * History (do not re-derive from scratch — this is the third design):
 *   1. #225's `redactSpoolEnvelope` — a hand-maintained four-field
 *      allowlist (turns[].text, events[].text, events[].evidence, legacy
 *      content). Correct for every field the schema names, but missed
 *      secrets in any field OUTSIDE the schema (a reshaped/debug/malformed
 *      envelope — the dominant quarantine population).
 *   2. A bare recursive "redact every string" walk (`redactValuesDeep`,
 *      #230's quarantine-sweep fix, briefly also tried on the write path).
 *      Fixes (1)'s coverage gap but destroys `session_id` — see above.
 *   3. THIS module: derive the schema's own field vocabulary at runtime
 *      (`.shape`/`.element`/`.unwrap()` — all public, documented Zod APIs,
 *      no private `_zod` internals) and redact (a) the small, explicitly
 *      content-typed fields, always; (b) any key the schema doesn't define
 *      at all, always (closes (1)'s gap); protect (never redact) any key
 *      the schema DOES define that isn't in the content list — a NEW
 *      structural field is protected automatically the moment it's added
 *      to the schema, no list to remember. The only field that still
 *      requires a human decision is "is this new field free text" — Zod's
 *      type system cannot derive that; `spool-classification.test.ts`
 *      turns a missed decision into a failing test instead of a silent
 *      plaintext leak (ADR-015 rule 6 — a canary that can only ever have
 *      one classification, "unclassified", is a canary; assert it, don't
 *      trust it by omission).
 */
import { z } from 'zod';
import { CanonicalIngestSchema } from '../server/routes/ingest.js';
import { redactIfEnabled } from '../redact/index.js';
import type { Config } from '../config/config.js';

// ---------------------------------------------------------------------------
// Generic schema introspection — public Zod API only (.shape / .element /
// .unwrap()), reused identically by the redaction walker below AND by
// spool-classification.test.ts's completeness check, so the two can never
// see a different picture of the schema.
// ---------------------------------------------------------------------------

/**
 * Peels every `.optional()` / `.nullable()` / `.default()` wrapper off a
 * Zod schema via its public `.unwrap()` method, down to the base type.
 *
 * Subtlety that cost real debugging time: `ZodArray` ALSO exposes a public
 * `.unwrap()` — but its semantics are "give me the ELEMENT schema," not
 * "peel one modifier layer," so a naive `while (typeof cur.unwrap ===
 * 'function')` loop unwraps straight PAST an array into its element type
 * (e.g. `turns: z.array(TranscriptTurnSchema).optional()` resolved all the
 * way to `TranscriptTurnSchema` itself, silently losing the fact that
 * `turns` is an array at all — caught by `spool-classification.test.ts`
 * producing dotted paths like `turns.role` instead of `turns[].role`
 * before this fix). The loop stops the moment `cur` already exposes
 * `.shape` or `.element` — i.e. the moment it's already a container type
 * `resolveField` below knows how to use directly — so it never asks a
 * container "do you have another layer to peel," regardless of whether
 * that container happens to have its own unrelated `.unwrap()`.
 */
export function unwrapToBase(schema: z.ZodTypeAny): z.ZodTypeAny {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = schema;
  while (typeof cur.unwrap === 'function' && !('shape' in cur) && !('element' in cur)) {
    cur = cur.unwrap();
  }
  return cur as z.ZodTypeAny;
}

export type ZodShapeType = Record<string, z.ZodTypeAny>;

export interface ResolvedField {
  /** The nested field-name -> schema map to recurse into, or `undefined`
   *  if this field is a scalar leaf (string/number/boolean/enum/etc). For
   *  an array field, this is the shape of ONE array element (every item
   *  shares it) — `undefined` if the array holds scalars, not objects. */
  childShape: ZodShapeType | undefined;
  /** True if the field itself is an array (its value should be walked
   *  item-by-item, each item checked against `childShape`). */
  isArray: boolean;
}

/** Classify one field's schema: does it have children to recurse into
 *  (object -> `.shape`, array -> `.element`'s shape), or is it a leaf? */
export function resolveField(fieldSchema: z.ZodTypeAny): ResolvedField {
  const base = unwrapToBase(fieldSchema) as unknown as { shape?: unknown; element?: z.ZodTypeAny };
  if (base.shape && typeof base.shape === 'object') {
    return { childShape: base.shape as ZodShapeType, isArray: false };
  }
  if (base.element) {
    const elementBase = unwrapToBase(base.element) as unknown as { shape?: unknown };
    const childShape = elementBase.shape && typeof elementBase.shape === 'object' ? (elementBase.shape as ZodShapeType) : undefined;
    return { childShape, isArray: true };
  }
  return { childShape: undefined, isArray: false };
}

/**
 * Recursively enumerate every LEAF field path in a Zod object shape —
 * dotted for nested objects, `[]`-suffixed for array elements (one
 * representative path per array, since every item shares one schema).
 * Stops at scalars; used ONLY by the classification test to prove every
 * field the schema defines has been explicitly bucketed as content or
 * structural — the redaction walker below does not need this function,
 * it walks the actual value tree instead.
 */
export function collectLeafPaths(shape: ZodShapeType, prefix = ''): string[] {
  const paths: string[] = [];
  for (const [key, fieldSchema] of Object.entries(shape)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const resolved = resolveField(fieldSchema);
    if (resolved.isArray) {
      const arrPath = `${path}[]`;
      if (resolved.childShape !== undefined) paths.push(...collectLeafPaths(resolved.childShape, arrPath));
      else paths.push(arrPath); // array of scalars — no such field today, treated as one leaf
    } else if (resolved.childShape !== undefined) {
      paths.push(...collectLeafPaths(resolved.childShape, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// The two hand-maintained classification lists. This is the only place a
// human judgment call is required — Zod's type system can prove a field
// EXISTS and what shape it has, but "is this free text a person or model
// wrote" is semantic, not typed. spool-classification.test.ts asserts
// CONTENT_FIELD_PATHS ∪ KNOWN_STRUCTURAL_FIELD_PATHS covers every leaf
// `collectLeafPaths(CanonicalIngestSchema.shape)` finds — a field in
// neither list fails CI instead of silently reaching disk unredacted (a
// new content field) or silently being destroyed (a new structural field
// wrongly redacted, if this list were ever inverted).
// ---------------------------------------------------------------------------

/** Free text a human or model produced — always redacted, regardless of
 *  nesting. Deliberately small and stable: these are the exact three
 *  canonical-envelope fields #225's original `redactSpoolEnvelope`
 *  allowlist already redacted correctly (the legacy envelope's `content`
 *  field is out of scope here — no real `writeToSpool` caller ever
 *  produces a legacy-shaped v0.0 envelope; both `cli/capture.ts` and
 *  `capture/proxy.ts` build canonical v1.0 envelopes exclusively). */
export const CONTENT_FIELD_PATHS: ReadonlySet<string> = new Set([
  'turns[].text',
  'events[].text',
  'events[].evidence',
]);

/**
 * Every other leaf field `CanonicalIngestSchema` defines — identifiers,
 * enums, timestamps, versions, telemetry the daemon interprets rather than
 * displays. Never redacted. `session_id`/`project_id`/`agent_type`/`cwd`
 * are the sharp cases (silent correlation/repo-tagging corruption if
 * redacted — see module doc); the rest are either self-protecting via a
 * Zod format/enum check (redacting them fails LOUD at drain-time
 * `safeParse` instead) or low-stakes telemetry (`client_version`,
 * `proxy_usage.model`/`stop_reason`) — this module treats all of them
 * identically (protect, don't redact) rather than tiering by severity:
 * the mechanism costs nothing extra to apply uniformly, and a severity
 * tier is an invitation to stop checking one of them carefully.
 */
export const KNOWN_STRUCTURAL_FIELD_PATHS: ReadonlySet<string> = new Set([
  'event',
  'session_id',
  'project_id',
  'agent_type',
  'cwd',
  'captured_at',
  'kind',
  'tool',
  'capture_source',
  'extract_profile',
  'client_scrub_applied',
  'client_scrub_hits',
  'client_version',
  'client_scrub_version',
  'client_scrub_hits_by_label',
  'wire_version',
  'turns[].role',
  'turns[].ts',
  'events[].type',
  'events[].importance',
  'events[].confidence',
  'events[].occurred_at',
  'proxy_usage.provider',
  'proxy_usage.model',
  'proxy_usage.input_tokens',
  'proxy_usage.output_tokens',
  'proxy_usage.total_tokens',
  'proxy_usage.cache_creation_input_tokens',
  'proxy_usage.cache_read_input_tokens',
  'proxy_usage.stop_reason',
  'proxy_usage.truncated',
]);

/** The shape every `writeToSpool` caller's envelope is checked against.
 *  Exported so the completeness test can walk the exact same schema this
 *  module redacts against, without re-importing/re-deriving it itself. */
export const CANONICAL_ENVELOPE_SHAPE: ZodShapeType = CanonicalIngestSchema.shape;

// ---------------------------------------------------------------------------
// The redaction walker.
// ---------------------------------------------------------------------------

/**
 * Redact a captured envelope for the ingest-spool WRITE path. Walks
 * `value` alongside `CanonicalIngestSchema`'s own shape:
 *  - a field path in `CONTENT_FIELD_PATHS` is always redacted;
 *  - a field the schema recognizes (present in the shape at that nesting
 *    level) and is NOT a content path is NEVER redacted — this is what
 *    keeps `session_id` and friends intact;
 *  - a field the schema does NOT recognize at all — an unrecognized key at
 *    any depth, including everything nested under it — IS redacted. This
 *    is the actual coverage-gap fix: `CanonicalIngestSchema.safeParse`
 *    doesn't run until DRAIN time (src/ingest/spool-drain.ts), so
 *    `writeToSpool` sees envelopes no validation has touched yet, and a
 *    reshaped/debug-augmented envelope's extra fields are exactly the
 *    population most likely to carry a secret (same selection-effect
 *    argument as the quarantine sweep, src/ingest/spool.ts module doc).
 * Numbers, booleans, and null always pass through untouched — nothing to
 * redact structurally, and the recursive walk simply doesn't visit them
 * for redaction (though it does need to route to them to build the output
 * object back up, which it does below).
 */
export function redactSpooledEnvelope(value: unknown, config: Config): unknown {
  return walk(value, config, { childShape: CANONICAL_ENVELOPE_SHAPE, isArray: false }, '');
}

function walk(value: unknown, config: Config, known: ResolvedField | undefined, path: string): unknown {
  if (typeof value === 'string') {
    if (CONTENT_FIELD_PATHS.has(path)) return redactIfEnabled(value, config).text;
    if (known !== undefined) return value; // schema-recognized, not content -> structural, protect
    return redactIfEnabled(value, config).text; // schema has no opinion here -> unknown, redact
  }
  if (Array.isArray(value)) {
    const perItemShape = known?.isArray ? known.childShape : undefined;
    const itemKnown: ResolvedField | undefined = perItemShape !== undefined ? { childShape: perItemShape, isArray: false } : undefined;
    return value.map(item => walk(item, config, itemKnown, `${path}[]`));
  }
  if (value && typeof value === 'object') {
    const shape = known?.childShape;
    const out: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      const fieldSchema = shape?.[key];
      const childKnown = fieldSchema !== undefined ? resolveField(fieldSchema) : undefined;
      out[key] = walk(childValue, config, childKnown, childPath);
    }
    return out;
  }
  return value; // number, boolean, null — always safe, key itself is never touched
}
