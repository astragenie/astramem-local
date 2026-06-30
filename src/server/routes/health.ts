import type { FastifyInstance } from 'fastify';

const WIRE_VERSIONS_SUPPORTED = ['v0.0', 'v1.0'] as const;
const SCHEMA_VERSION = 2;

export async function healthRoute(app: FastifyInstance) {
  app.get('/health', async () => ({
    ok: true,
    version: '0.1.4',
    wire_versions_supported: WIRE_VERSIONS_SUPPORTED,
    schema_version: SCHEMA_VERSION,
  }));
}
