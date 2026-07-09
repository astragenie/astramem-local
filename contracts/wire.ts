/**
 * contracts/wire.ts — hand-written wire-protocol constants shared cross-repo.
 *
 * Unlike types/ and zod/ (generated 1:1 from schemas/*.schema.json), these
 * constants don't correspond to a single JSON Schema file — they're small,
 * stable literals (a version string, a compiled regex, a protocol name) that
 * astramem-local, astramem cloud (.NET), and astramem-plugin all need to
 * agree on bit-for-bit. Hand-written and versioned like validate.mjs /
 * generate-*.mjs; NOT touched by the codegen scripts.
 *
 * Import as `@astragenie/astramem-contracts/wire`.
 */

// ---------------------------------------------------------------------------
// Capture protocol (ADR-008) — POST /ingest/transcript envelope negotiation
// ---------------------------------------------------------------------------

/**
 * Current `wire_version` value this contracts package's capture-envelope@1
 * schema targets. Not the only value WIRE_VERSION_PATTERN accepts (the
 * capture protocol is negotiated per-request, and older `v0.x` senders are
 * still valid) — this is what a NEW writer conforming to this package
 * version should emit.
 */
export const WIRE_VERSION = 'v1.0' as const;

/**
 * `wire_version` field pattern — the M-R7 TIGHTENED form: ASCII digits only,
 * leading zeros disallowed in both the major and minor component, so
 * "v01.0" and "v1.01" are both rejected (and non-ASCII/Unicode-category-
 * Decimal digits, e.g. Arabic-Indic "١", never match `[0-9]`).
 *
 * Mirrors `capture-envelope.v1.schema.json`'s `wire_version.pattern` byte-
 * for-byte, and the SaaS cloud repo's
 * `AstraMemory.Modules.Ingest.Controllers.IngestTranscriptRequest.WireVersion`
 * `RegularExpression` attribute (`IngestTranscriptRequest.cs:65`) — see that
 * file's M-R7 comment for the full rationale.
 *
 * astramem-local's own `src/server/routes/ingest.ts` `wire_version` Zod
 * `.regex()` has NOT yet been migrated to this tightened form as of this
 * package version (it still accepts a leading-zero minor component,
 * e.g. "v1.01") — adopting this constant there is a follow-up, not part of
 * authoring the shared contract (see contracts/README.md changelog note).
 */
export const WIRE_VERSION_PATTERN = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;

/**
 * Domain@gen wire-contract vocabulary this package's schemas correspond to,
 * deduped in first-seen order. Mirrors (and must be kept in lockstep with)
 * `WIRE_VERSIONS_SUPPORTED` derived from `SCHEMA_FILE_TO_DOMAIN` in
 * `src/server/lib/wire-meta.ts` — that file can't `import` this package
 * directly (`tsconfig.json` scopes `rootDir` to `src/`, TS6059), so it holds
 * its own hand-mirrored copy, held honest by
 * `tests/contracts/wire-version-map-parity.test.ts`. That mirror is scoped to
 * `*.v1.schema.json` files only, so it is UNAFFECTED by the `atom@2` addition
 * below — `atom@2` cutover on the daemon/cloud side is separate follow-up
 * work, not part of authoring this contract package. This is a SEPARATE axis
 * from `WIRE_VERSION`/`WIRE_VERSION_PATTERN` above (the capture protocol's
 * per-request `wire_version` field) — do not conflate the two.
 */
export const WIRE_VERSIONS_SUPPORTED = ['atom@1', 'atom@2', 'retrieval@1', 'sync@1', 'capture@1'] as const;

// ---------------------------------------------------------------------------
// Entity kind registry (atom@2) — shared across atom.v2.schema.json
// `entities[].kind`/`entities[].subtype`, held in sync by
// tests/contracts/entity-kind-parity.test.ts.
// ---------------------------------------------------------------------------

/**
 * Canonical 12-value entity-kind registry (atom@2). `actor` covers both
 * humans and AI agents (see `ACTOR_KINDS` + the optional `subtype` field on
 * each entity item) — there is no separate person/agent kind. `repo` was cut
 * as its own kind: repo/project identity is owned by the structural
 * `provenance.project` field, and cross-repo mentions land in `product`.
 */
export const ENTITY_KINDS = [
  'actor',
  'team',
  'org',
  'project',
  'product',
  'workitem',
  'decision',
  'tech',
  'tool',
  'concept',
  'event',
  'other',
] as const;

/**
 * The subset of `ENTITY_KINDS` for which `entities[].subtype`
 * (`'human' | 'ai'`) is a meaningful refinement.
 */
export const ACTOR_KINDS = ['actor', 'team', 'org'] as const;

// ---------------------------------------------------------------------------
// Sync protocol (ADR-003)
// ---------------------------------------------------------------------------

/**
 * astramem-sync@1 protocol identifier. Mirrors `SYNC_PROTOCOL` in
 * `src/sync/shipper.ts` — the sync envelope's `protocol` field is always
 * this exact literal.
 */
export const SYNC_PROTOCOL = 'astramem-sync@1' as const;
