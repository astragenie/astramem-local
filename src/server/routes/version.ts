import type { FastifyInstance } from 'fastify';
import {
  PKG_VERSION,
  WIRE_VERSIONS_SUPPORTED,
  CONTRACT_SCHEMA_VERSION,
  SCHEMA_VERSION,
} from '../lib/wire-meta.js';

export async function versionRoute(app: FastifyInstance) {
  app.get('/version', async () => ({
    name: 'astramemory-local',
    version: PKG_VERSION,
    // U6 (#106): domain@gen wire-contract vocabulary (e.g. "atom@1"),
    // repurposed from the legacy flat v0.0/v1.0 envelope-negotiation list.
    wire_versions_supported: WIRE_VERSIONS_SUPPORTED,
    // U6 (#106): coarse wire-CONTRACT generation — distinct from
    // schema_version below (the SQLite migration counter).
    contract_schema_version: CONTRACT_SCHEMA_VERSION,
    schema_version: SCHEMA_VERSION,
    ts: Date.now(),
  }));
}
