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
// it `readdirSync`s contracts/schemas/*.v1.schema.json and fails the build if
// a schema file is added/removed without a matching update here.
//
// WIRE_VERSIONS_SUPPORTED is REPURPOSED from the old flat envelope-negotiation
// list (`['v0.0', 'v1.0']`) to this domain@gen vocabulary — the plugin's live
// wire-probe reads this exact field name. The per-request `wire_version`
// negotiation on POST /ingest/transcript (src/server/routes/ingest.ts, regex
// `^v(?:0|[1-9][0-9]*)\.[0-9]+$`) is a SEPARATE axis and does not read this
// constant or this map.
// ---------------------------------------------------------------------------

export const SCHEMA_FILE_TO_DOMAIN = {
  'atom.v1.schema.json': 'atom@1',
  'retrieval-query.v1.schema.json': 'retrieval@1',
  'retrieval-result.v1.schema.json': 'retrieval@1',
  'sync-envelope.v1.schema.json': 'sync@1',
  'capture-envelope.v1.schema.json': 'capture@1',
} as const satisfies Record<string, string>;

// Deduped, first-seen-order derivation from the map above (5 schema files ->
// 4 domains: retrieval-query + retrieval-result both collapse to `retrieval@1`).
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
//       '$.session_id')) WHERE kind='distill', hygiene batch 2026-07-08).
export const SCHEMA_VERSION = 18 as const;
