import type { FastifyInstance } from 'fastify';
import { PKG_VERSION, WIRE_VERSIONS_SUPPORTED, SCHEMA_VERSION } from '../lib/wire-meta.js';
import { type Config, defaultConfig } from '../../config/config.js';

export function healthRoute(config: Config = defaultConfig()) {
  return async (app: FastifyInstance) => {
    app.get('/health', async () => ({
      ok: true,
      version: PKG_VERSION,
      wire_versions_supported: WIRE_VERSIONS_SUPPORTED,
      schema_version: SCHEMA_VERSION,
      security: {
        redaction: config.security.redaction.enabled,
        encryption: config.security.encryption.enabled,
      },
    }));
  };
}
