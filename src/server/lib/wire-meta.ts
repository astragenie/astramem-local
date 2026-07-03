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
// Wire versions — single authoritative list
// ---------------------------------------------------------------------------

export const WIRE_VERSIONS_SUPPORTED = ['v0.0', 'v1.0'] as const satisfies readonly string[];

// ---------------------------------------------------------------------------
// Schema version — single authoritative literal
// migrate() asserts that MAX(version) FROM schema_version equals this constant
// at startup. Bump this whenever a new migration file is added.
// ---------------------------------------------------------------------------

// Migrations 001-013 (009 = tag hygiene FEAT-403; 010 = sync-pull event_id FEAT-407;
// 011 = embed-dim FEAT-409; 012 = entities/memory_entities FEAT-402 slice 1;
// 013 = memory TTL/archival tiers FEAT-404).
export const SCHEMA_VERSION = 13 as const;
