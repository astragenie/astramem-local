// FEAT-496 provenance emission (astramemory-local sync-emit-provenance lane).
//
// Cloud's SyncIngestService (memory#C2-2, ReadCaptionProvenanceJson) reads
// evidence[0].speaker_label / evidence[0].segment_start_ms and
// provenance.consent_disclosed straight off the sync create-event
// payload_json. Before this fix, MemoryRepo.insertWithCreateEvent never put
// those fields there at all — migration 049's doc comment called this out
// explicitly as "no live JSON-emission path yet". This suite proves the gap
// is closed for the two fields this storage layer actually has data for
// (speaker_label, consent_disclosed — segment_start_ms has no producer
// anywhere in the local pipeline, see the doc comment in memories.ts), and
// that the shape matches the real generated atom@2 zod schema, not just an
// ad-hoc object literal.
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { AtomV2Schema } from '../../contracts/zod/atom.v2.js';

function readCreatePayload(events: MemoryEventRepo, atomId: string): Record<string, unknown> {
  const rows = events.listForAtom(atomId);
  const createRow = rows.find(r => r.event_type === 'create');
  expect(createRow).toBeDefined();
  expect(createRow!.payload_json).not.toBeNull();
  return JSON.parse(createRow!.payload_json!) as Record<string, unknown>;
}

/**
 * The create-event payload is deliberately a PARTIAL atom@2 projection (no
 * id/valid_from/valid_to/content_hash/created_at/updated_at — those live on
 * the memories row / event envelope, not payload_json). To prove the two
 * fields this lane adds are shaped exactly like atom.v2.schema.json expects
 * (not just "some object with the right key names"), wrap the payload's
 * evidence/provenance fragments into a fully-populated synthetic atom and
 * run it through the SAME generated zod schema the cloud/contracts package
 * ships — a real `.parse()`, not `safeParse` swallowed and ignored.
 */
function wrapAsFullAtom(payload: Record<string, unknown>): unknown {
  return {
    schema: 'astramem/atom@2',
    id: '11111111-1111-4111-8111-111111111111',
    type: payload.type,
    text: payload.text,
    evidence: payload.evidence ?? 'fallback excerpt when no structured evidence was emitted',
    confidence: payload.confidence,
    importance: payload.importance,
    provenance: {
      project: (payload.repo as string) || null,
      ...(payload.provenance as Record<string, unknown> | undefined),
    },
    valid_from: '2026-07-14T00:00:00.000Z',
    valid_to: null,
    scope: payload.scope,
    content_hash: 'a'.repeat(64),
    created_at: '2026-07-14T00:00:00.000Z',
    updated_at: '2026-07-14T00:00:00.000Z',
    ...(payload.entities !== undefined ? { entities: payload.entities } : {}),
  };
}

describe('insertWithCreateEvent — FEAT-496 provenance emission', () => {
  it('emits speaker_label (as evidence[0].speaker_label) and consent_disclosed (as provenance.consent_disclosed) when the caller supplies them', () => {
    const db = openDb(':memory:');
    migrate(db);
    const memories = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);

    const { id } = memories.insertWithCreateEvent(
      {
        type: 'fact',
        text: 'provenance-emission: the operator confirmed the meeting recording',
        normalized_text: 'provenance-emission: the operator confirmed the meeting recording',
        repo: 'astramem-local',
        project: 'astramem',
        branch: null,
        agent: null,
        session_id: null,
        hash: '1'.repeat(64),
        source_hash: 'src-hash-abc123',
        evidence: 'the operator confirmed the meeting recording',
        speaker_label: 'Jane Doe',
        consent_disclosed: true,
      },
      events,
    );

    const payload = readCreatePayload(events, id);

    expect(payload.evidence).toEqual([{ transcript_id: 'src-hash-abc123', speaker_label: 'Jane Doe' }]);
    expect(payload.provenance).toEqual({ consent_disclosed: true });

    // Shape fidelity: the emitted fragments parse cleanly as a real atom@2.
    expect(() => AtomV2Schema.parse(wrapAsFullAtom(payload))).not.toThrow();
  });

  it('consent_disclosed=false round-trips distinctly from absent (tri-state, key-presence signal)', () => {
    const db = openDb(':memory:');
    migrate(db);
    const memories = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);

    const { id } = memories.insertWithCreateEvent(
      {
        type: 'fact',
        text: 'provenance-emission: consent was explicitly declined',
        normalized_text: 'provenance-emission: consent was explicitly declined',
        repo: 'astramem-local',
        project: null,
        branch: null,
        agent: null,
        session_id: null,
        hash: '2'.repeat(64),
        source_hash: null,
        consent_disclosed: false,
      },
      events,
    );

    const payload = readCreatePayload(events, id);
    expect(payload.provenance).toEqual({ consent_disclosed: false });
    expect(() => AtomV2Schema.parse(wrapAsFullAtom(payload))).not.toThrow();
  });

  it('older-style memory with no speaker_label/consent_disclosed emits neither key — byte-identical to pre-FEAT-496 payloads', () => {
    const db = openDb(':memory:');
    migrate(db);
    const memories = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);

    const { id } = memories.insertWithCreateEvent(
      {
        type: 'fact',
        text: 'provenance-emission: an ordinary /remember write with no caption/audio provenance',
        normalized_text: 'provenance-emission: an ordinary /remember write with no caption/audio provenance',
        repo: 'astramem-local',
        project: null,
        branch: null,
        agent: null,
        session_id: null,
        hash: '3'.repeat(64),
        source_hash: null,
      },
      events,
    );

    const payload = readCreatePayload(events, id);
    expect(payload).not.toHaveProperty('evidence');
    expect(payload).not.toHaveProperty('provenance');

    // Still schema-valid as a full atom once wrapped (the absence case).
    expect(() => AtomV2Schema.parse(wrapAsFullAtom(payload))).not.toThrow();
  });

  it('consent_disclosed=null (explicit "not applicable") is treated the same as omitted — no provenance key', () => {
    const db = openDb(':memory:');
    migrate(db);
    const memories = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);

    const { id } = memories.insertWithCreateEvent(
      {
        type: 'fact',
        text: 'provenance-emission: explicit null consent value',
        normalized_text: 'provenance-emission: explicit null consent value',
        repo: 'astramem-local',
        project: null,
        branch: null,
        agent: null,
        session_id: null,
        hash: '4'.repeat(64),
        source_hash: null,
        consent_disclosed: null,
      },
      events,
    );

    const payload = readCreatePayload(events, id);
    expect(payload).not.toHaveProperty('provenance');
  });

  it('speaker_label without source_hash falls back to the atom content hash as transcript_id (never empty)', () => {
    const db = openDb(':memory:');
    migrate(db);
    const memories = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);

    const { id } = memories.insertWithCreateEvent(
      {
        type: 'fact',
        text: 'provenance-emission: speaker label with no source_hash available',
        normalized_text: 'provenance-emission: speaker label with no source_hash available',
        repo: 'astramem-local',
        project: null,
        branch: null,
        agent: null,
        session_id: null,
        hash: '5'.repeat(64),
        source_hash: null,
        speaker_label: 'Unlabeled Speaker',
      },
      events,
    );

    const payload = readCreatePayload(events, id);
    expect(payload.evidence).toEqual([{ transcript_id: '5'.repeat(64), speaker_label: 'Unlabeled Speaker' }]);
    expect(() => AtomV2Schema.parse(wrapAsFullAtom(payload))).not.toThrow();
  });
});
