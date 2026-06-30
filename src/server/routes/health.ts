import type { FastifyInstance } from 'fastify';
import { PKG_VERSION, WIRE_VERSIONS_SUPPORTED, SCHEMA_VERSION } from '../lib/wire-meta.js';

export async function healthRoute(app: FastifyInstance) {
  app.get('/health', async () => ({
    ok: true,
    version: PKG_VERSION,
    wire_versions_supported: WIRE_VERSIONS_SUPPORTED,
    schema_version: SCHEMA_VERSION,
  }));
}
