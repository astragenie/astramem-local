/**
 * Single source of truth for wire protocol metadata and package version.
 * Both health.ts and version.ts import from here; no literal duplicates.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Package version — read once at module load, Zod-validated cast
// ---------------------------------------------------------------------------

const _dir = dirname(fileURLToPath(import.meta.url));
const _pkgPath = join(_dir, '..', '..', '..', 'package.json');

const _PkgSchema = z.object({ version: z.string() });

export const PKG_VERSION: string = _PkgSchema.parse(
  JSON.parse(readFileSync(_pkgPath, 'utf-8')),
).version;

// ---------------------------------------------------------------------------
// Wire versions — single authoritative list (U6 wire-version unification,
// astramem-local#106)
//
// `tsconfig.json` scopes `rootDir` to `src/`, so this file cannot `import`
// `contracts/schemas/*.v1.schema.json` directly (contracts/ lives outside
// rootDir -> tsc TS6059, same constraint documented in
// src/contracts/recall-filters.ts). SCHEMA_FILE_TO_DOMAIN is therefore a
// **hand-mirrored, explicit** map of every `contracts/schemas/*.v1.schema.json`
// file to its un-prefixed `domain@gen` id. The schema `title` fields are NOT
// parsed to derive this list — they are internally inconsistent prefix-wise
// (atom.v1 uses `astramem/atom@1`; the rest use `astramem-<domain>@1 ...`
// with trailing words like "envelope"/"query"/"result").
//
// `tests/contracts/wire-version-map-parity.test.ts` is the regression gate:
// it `readdirSync`s contracts/schemas/*.v{N}.schema.json and fails the build
// if a schema file is added/removed without a matching update here.
//
// WIRE_VERSIONS_SUPPORTED is REPURPOSED from the old flat envelope-negotiation
// list (`['v0.0', 'v1.0']`) to this domain@gen vocabulary — the plugin's live
// wire-probe reads this exact field name. The per-request `wire_version`
// negotiation on POST /ingest/transcript (src/server/routes/ingest.ts, regex
// `^v(?:0|[1-9][0-9]*)\.[0-9]+$`) is a SEPARATE axis and does not read this
// constant or this map.
//
// atom@2 (2026-07-09, local writer adoption slice): `atom.v2.schema.json`
// was added to contracts/schemas/ alongside atom.v1 for a time-boxed dual-
// read window (ADR-001 amendment) — this map now carries BOTH atom@1 and
// atom@2 entries (the only domain with two generations live at once; the
// contracts package's own contracts/wire.ts WIRE_VERSIONS_SUPPORTED already
// listed atom@2 from the moment the schema was authored — see that file's
// comment explaining the daemon-side wiring was deliberately deferred to
// this slice). atom@1 stays advertised/mapped until the dual-read window
// closes (TODO: drop the atom.v1.schema.json entry + atom@1 reader support
// together, tracked alongside TODO(remove-personal-alias)).
// ---------------------------------------------------------------------------

export const SCHEMA_FILE_TO_DOMAIN = {
  'atom.v1.schema.json': 'atom@1',
  'atom.v2.schema.json': 'atom@2',
  'retrieval-query.v1.schema.json': 'retrieval@1',
  'retrieval-result.v1.schema.json': 'retrieval@1',
  'sync-envelope.v1.schema.json': 'sync@1',
  'capture-envelope.v1.schema.json': 'capture@1',
} as const satisfies Record<string, string>;

// Deduped, first-seen-order derivation from the map above (6 schema files ->
// 5 domains: retrieval-query + retrieval-result both collapse to `retrieval@1`).
export const WIRE_VERSIONS_SUPPORTED = Array.from(
  new Set(Object.values(SCHEMA_FILE_TO_DOMAIN)),
) as readonly string[];

// ---------------------------------------------------------------------------
// Contract schema version — coarse wire-CONTRACT generation (U6, #106).
// Distinct from SCHEMA_VERSION below (the SQLite migration counter, hard-
// asserted by migrate()'s drift guard) — this is a separate, additive field.
// Bump when the domain@gen vocabulary itself changes generation.
// ---------------------------------------------------------------------------

export const CONTRACT_SCHEMA_VERSION = '1' as const;

// ---------------------------------------------------------------------------
// Schema version — single authoritative literal
// migrate() asserts that MAX(version) FROM schema_version equals this constant
// at startup. Bump this whenever a new migration file is added.
// ---------------------------------------------------------------------------

// Migrations 001-018 (009 = tag hygiene FEAT-403; 010 = sync-pull event_id FEAT-407;
// 011 = embed-dim FEAT-409; 012 = entities/memory_entities FEAT-402 slice 1;
// 013 = memory TTL/archival tiers FEAT-404; 014 = sync_ship_state FEAT-434;
// 015 = canonical 64-char content_hash recompute, astramem-local#84;
// 016 = scope 'personal' -> 'private' rename, U7-local astramem-local#110;
// 017 = widen memories.type CHECK 7 -> 10, U4-local #111/#112 ADR D4;
// 018 = partial expression index on jobs(json_extract(payload_json,
//       '$.session_id')) WHERE kind='distill', hygiene batch 2026-07-08;
// 019 = partial expression indexes on memory_events(created_at, atom_id) for
//       the two usefulness families + covering index on memories(agent,
//       valid_to, archived, type, created_at DESC), perf baseline
//       2026-07-08 candidates #2/#3;
// 020 = follow-up to 019 -- partial index on memory_events(event_type,
//       created_at DESC, atom_id) restoring the cheap join order for
//       buildAgentProfile's corrections query, which 019's memories.agent
//       index had regressed (see migration 020 file header for the measured
//       before/after).
// 021 = widen memory_events.event_type CHECK to add 'unsupersede' (FEAT-442
//       reversal primitive for autonomous-consolidation auto-accept) --
//       same create-copy-swap table-rewrite pattern migration 013 used.
// 022 = consolidation_proposals.metadata_json, additive nullable column
//       (FEAT-456 SLICE-1 contradiction judge verdict/confidence/excerpts).
// 023 = memory_entities surrogate-PK rebuild + nullable valid_at/invalid_at
//       (FEAT-453 SLICE-2 fact-level bitemporal tracking) -- same
//       create-copy-swap pattern as 021; see migration file header and
//       docs/specs/FEAT-453-bitemporal-design.md §1.
// 024 = transcripts.capture_source / memories.capture_source, additive
//       nullable columns + partial index (FEAT-455, ADR-012 decision 4).
// 025 = widen memory_events.event_type CHECK to add 'purge'/'unpurge'
//       (FEAT-467 purge-batch reversal primitive, ADR-013 Decision 4 gate)
//       -- same create-copy-swap pattern as 021/023 -- plus the additive
//       nullable memories.purge_batch_id column + partial index, and the
//       new purge_batches audit table.
// 026 = transcripts.proxy_usage_json, additive nullable column (FEAT-458 S6
//       -- wires extractUsageMetadata's token/cost telemetry, S5-authored
//       and previously unattached, into durable storage).
// 027 = entity_relations table (FEAT-481 SLICE-1) -- entity-to-entity
//       relation triples, cloud-parity schema (see migration file header and
//       docs/specs/FEAT-481-design.md §1); ON DELETE CASCADE on all three
//       FKs is a deliberate divergence from cloud's RESTRICT (ADR-006
//       erase_memory).
// 028 = transcripts.extract_profile, additive nullable column (FEAT-479 D3
//       §3.2 AC-3) -- per-ingest override of distill.extractProfile, flows
//       transcripts row -> distillHandler -> PipelineContext.extractProfile
//       the same way capture_source (024) already does.
// 029 = relation_guard_drops table (FEAT-481 SLICE-430) -- append-only
//       drop-reason counters for the entity-relation extraction guard
//       (filterAtomRelations in src/distill/stages/05-extract.ts + the
//       unresolvable-at-write defensive skip in 08-embed-index.ts), same
//       shape/precedent as redaction_log (005). Lets the doctor "Entity
//       relations extraction" canary distinguish "model never emits a
//       relation" from "model emits relations but the guard drops every one"
//       -- see src/storage/relation-guard-log.ts.
// 030 = consolidation_judge_runs table (FEAT-482) -- append-only telemetry
//       (judge call count + wall-clock elapsed ms) for the contradiction
//       judge's pairwise sweep (src/consolidate/consolidate.ts). Dollars
//       cannot bound this judge -- both shipped LLM providers report
//       `usage.usd: 0` -- so runConsolidation caps it by call count
//       (maxPerRun) and wall-clock time (maxWallClockMs) instead, and this
//       table makes the actual cost visible to the doctor "Consolidation
//       judge" canary rather than gated behind a currency that can't see it.
// 032 = transcripts.captured_at_local_date, additive nullable column
//       (2026-07-13 timezone-offset bugfix) -- the local calendar date at
//       capture (the offset-bearing captured_at string's own YYYY-MM-DD
//       prefix), alongside the pre-existing epoch-only captured_at column.
//       Flows transcripts row -> distillHandler -> PipelineContext.
//       capturedAtLocalDate -> stage-5 sessionDateIso, replacing the old
//       UTC-derived-from-epoch anchor that ignored the user's local offset.
//       NULL (falls back to the old UTC-derived behavior) for every row
//       from before this fix and for the events-kind ingest path, which
//       never runs extraction and so never needed this.
// 033 = consolidation_judge_runs.judge_errors, additive NOT NULL DEFAULT 0
//       column (silent-error audit, 2026-07-13) -- count of judgeCalls that
//       fell back to FALLBACK_VERDICT due to a parse/call failure, so the
//       "Consolidation judge" doctor check can tell "judge ran and found
//       nothing" apart from "judge silently failed every call" (same shape
//       as issues #190/#200). See migrations/033-consolidation-judge-errors.sql.
// 034 = entity_name_drops table (issue #207) -- append-only guard-drop
//       counters for filterAtomEntities (src/distill/stages/05-extract.ts),
//       a SEPARATE table from relation_guard_drops (029) so that table's own
//       sum stays scoped to relation-guard reasons only. Lets the doctor
//       "Entity name quality" canary distinguish "the guard has stopped
//       seeing new junk names" from "the guard is actively catching junk on
//       an ongoing basis" -- see src/storage/entity-guard-log.ts.
// 035 = schema_version.filename + schema_version.content_hash, additive
//       nullable columns (issue #188, root-caused by the 2026-07-13 #185/#186
//       migration-030 collision + re-collision outage). Lets migrate()
//       verify on every boot that the file occupying a version number today
//       still hashes to what was actually applied when that version was
//       recorded, instead of keying a migration's identity on the number
//       alone. See migrations/035-schema-version-content-hash.sql and
//       migrate.ts's post-apply-loop verify/backfill pass. Numbered 035, not
//       033/034, after TWO separate concurrent-migration collisions during
//       coordination for this very fix (#208 took 033, #218 took 034 despite
//       an earlier team-lead assignment of 036 to #218) -- ground-truthed
//       against `git ls-tree origin/main -- migrations/` immediately before
//       each renumber, not against other agents' claims.
// 036 = memory_events.rejected_at, additive nullable column (sync-promote-
//       wedge fix): a cloud-rejected create/promote_scope event is now
//       marked TERMINAL client-side (never resent) instead of being
//       re-selected by listUnsynced on every round forever. See migration
//       036 file header and src/sync/shipper.ts shipOnce's rejected_seqs
//       handling. Authored as 033; renumbered to 036 at merge time -- 033,
//       034 and 035 were all taken by PRs (#208, #218, #212) that landed
//       while this branch was open. Ground-truthed against
//       `git ls-tree origin/main -- migrations/`, not against the branch.
// 037 = memories.validity_extracted, additive NOT NULL DEFAULT 0 column
//       (issue #205): provenance flag distinguishing "extraction never
//       considered this atom's validity" (0, every existing row) from
//       "extraction considered it — valid_to is NULL because genuinely
//       unbounded, or populated because the source text stated an end" (1).
//       valid_to semantics and validityFilterClause() are UNCHANGED by this
//       migration — see the migration file's own header for why redefining
//       NULL was a trap (collapses to either a no-op or a corpus-nuke).
//       Authored as 033, renumbered to 034, 035, 036 and finally 037 as each
//       number in turn was taken by a PR that landed while this branch was
//       open (#208, #218, #212, #210). FOUR renumbers for one migration is
//       not diligence, it is a design defect: the expected version is a
//       hardcoded literal here AND in eight test files, so any two
//       migration-bearing PRs conflict by construction no matter what they
//       change. Derive it from the migrations directory instead -- tracked
//       as the follow-up to this queue.
// 038 = validity_guard_drops counter table (issue #205 follow-up) -- counts
//       extracted valid_at/invalid_at bounds the write-path guard REFUSED.
//       #216 wired the model's `invalid_at` straight into memories.valid_to
//       with no validation at all; a single hallucinated date silently and
//       permanently removed a real memory from every default recall. The guard
//       now keeps the atom and drops the BOUND -- and counts the refusal here,
//       so "the model states no end dates" (real zero) stays distinguishable
//       from "the model states end dates and every one is garbage" (broken
//       zero). Same shape as relation_guard_drops (029) / entity_name_drops
//       (034), deliberately -- one readable family of guard canaries.
export const SCHEMA_VERSION = 39 as const;
// 039 = entity_link_drops table (issue #200 AC-3) -- same reason/count/
//       session_id/created_at shape as relation_guard_drops (029),
//       entity_name_drops (034) and validity_guard_drops (038). Lets the
//       doctor "Entity link rate" canary distinguish "the model emitted no
//       entities[] for this atom" (a REAL zero) from "the model emitted
//       entities but the write failed" (a BROKEN zero) -- see
//       src/storage/entity-link-log.ts.
//
// Numbering note (2026-07-13): NINE collisions on this range in ONE DAY, one
// of which bricked production. Take the number from
// `git ls-tree origin/main -- migrations/` immediately before pushing -- never
// from a teammate's message, never from your branch's history, and never from
// a green CI check (a green check on a stale base is what caused the outage).
// tests/storage/migration-renumber.test.ts is the only authority that cannot
// go stale. The real fix is to stop minting these by coordination at all --
// see the timestamp-id proposal in the architecture review.
