import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';

// Read package version once at module load — not per request.
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', '..', '..', 'package.json');
const PKG_VERSION: string = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }).version;

const WIRE_VERSIONS_SUPPORTED = ['v0.0', 'v1.0'] as const;
const SCHEMA_VERSION = 2;

export async function versionRoute(app: FastifyInstance) {
  app.get('/version', async () => ({
    name: 'astramemory-local',
    version: PKG_VERSION,
    wire_versions_supported: WIRE_VERSIONS_SUPPORTED,
    schema_version: SCHEMA_VERSION,
    ts: Date.now(),
  }));
}
