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

// NOTE (FEAT-407 coordination): FEAT-403 (tag hygiene) claims migration 009
// / SCHEMA_VERSION 9 on main. This worktree forked before that landed (only
// 001-008 present here), so 009 is intentionally skipped — FEAT-407's
// migration is 010-sync-pull.sql / SCHEMA_VERSION 10, leaving 9 free for
// FEAT-403 to merge first without a version collision.
export const SCHEMA_VERSION = 10 as const;
