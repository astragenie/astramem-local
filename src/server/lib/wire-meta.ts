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
// Boot-time assertion (in migrate.ts or server entry) should verify that
// MAX(version) FROM schema_version equals this constant. If drift is detected
// the server should refuse to start. Drift guard is a v0.3.0 FEAT (D-DEF2).
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 2 as const;
