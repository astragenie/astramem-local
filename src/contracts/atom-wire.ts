/**
 * Memory row -> astramem/atom@1 wire shape (ADR-001, contracts/schemas/atom.v1.schema.json).
 *
 * astramem-local's storage columns are the pragmatic v1 form: flat
 * provenance fields (repo/project/agent/session_id), epoch-ms timestamps,
 * and a single evidence excerpt string. The wire contract nests provenance
 * and uses ISO 8601 timestamps to match the capture envelope precedent
 * (docs/capture-protocol.md) and to stay storage-engine-agnostic for the
 * cloud (.NET/Postgres) consumer. This mapper is the one place that
 * reconciles the two shapes — see contracts/README.md "Evidence
 * reconciliation" for why evidence is left as-is (string) rather than
 * upgraded to the array-of-refs form here.
 */

import type { Memory } from './memory.js';
import { PKG_VERSION } from '../server/lib/wire-meta.js';

export interface AtomWireV1 {
  schema: 'astramem/atom@1';
  id: string;
  type: string;
  text: string;
  evidence: string | Array<{ transcript_id: string; span?: [number, number] }>;
  confidence: number;
  importance: number;
  provenance: {
    tool: string | null;
    session_id: string | null;
    repo: string | null;
    project: string | null;
    extractor: string | null;
  };
  valid_from: string;
  valid_to: string | null;
  superseded_by: string | null;
  derived_from: string[] | null;
  scope: string;
  content_hash: string;
  entities: string[];
  created_at: string;
  updated_at: string;
}

/** epoch ms -> ISO 8601 string. */
function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Serialize a local `memories` row into the astramem/atom@1 wire shape.
 * Pure function — no I/O, no DB access — so it is trivially unit-testable
 * and reusable from the (future) sync shipper (Wave 3d).
 */
export function toAtomWireV1(memory: Memory): AtomWireV1 {
  return {
    schema: 'astramem/atom@1',
    id: memory.id,
    type: memory.type,
    text: memory.text,
    // Local v1 form: evidence is stored as a plain excerpt string (or absent).
    // Empty-string fallback keeps the field non-optional per the schema's
    // `evidence` requirement ("receipts — never optional", ADR-001) even for
    // pre-AM-1 rows that predate the evidence column.
    evidence: memory.evidence ?? '',
    confidence: memory.confidence,
    importance: memory.importance,
    provenance: {
      tool: memory.agent,
      session_id: memory.session_id,
      repo: memory.repo,
      project: memory.project,
      extractor: `astramem-local@${PKG_VERSION}`,
    },
    valid_from: toIso(memory.valid_from),
    valid_to: memory.valid_to !== null ? toIso(memory.valid_to) : null,
    superseded_by: memory.superseded_by,
    derived_from: memory.derived_from,
    scope: memory.scope,
    content_hash: memory.hash,
    entities: [],
    created_at: toIso(memory.created_at),
    updated_at: toIso(memory.updated_at),
  };
}
