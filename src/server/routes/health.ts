import type { FastifyInstance } from 'fastify';
import { PKG_VERSION, WIRE_VERSIONS_SUPPORTED, SCHEMA_VERSION } from '../lib/wire-meta.js';
import { type Config, defaultConfig } from '../../config/config.js';
import type { DB } from '../../storage/db.js';
import { usefulnessRate } from '../../storage/usefulness.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * db is optional so /health keeps working for any caller that doesn't wire a
 * DB (defensive default) — the usefulness block degrades to zeros rather
 * than 500ing.
 */
export function healthRoute(config: Config = defaultConfig(), db?: DB) {
  return async (app: FastifyInstance) => {
    app.get('/health', async () => {
      const rate = db ? usefulnessRate(db, { sinceMs: Date.now() - SEVEN_DAYS_MS }) : { served: 0, used: 0, rate: null };
      return {
        ok: true,
        version: PKG_VERSION,
        wire_versions_supported: WIRE_VERSIONS_SUPPORTED,
        schema_version: SCHEMA_VERSION,
        security: {
          redaction: config.security.redaction.enabled,
          encryption: config.security.encryption.enabled,
        },
        // ADR-010: recall-usefulness rate (v1: measure only, does not feed ranking).
        usefulness: {
          served_7d: rate.served,
          used_7d: rate.used,
          rate_7d: rate.rate,
        },
      };
    });
  };
}
