/**
 * FEAT-481 SLICE-3 — MCP conformance for get_entity_related / get_entity_timeline
 * (design doc §4.1). Real in-process McpServer over Streamable HTTP, real
 * sqlite (:memory:), same pattern as tests/mcp/agent-profile-conformance.test.ts.
 *
 * Field names asserted here are byte-identical to cloud's shipped
 * get_entity_related/get_entity_timeline (src/AstraMemory.Mcp/Tools/EntityTools.cs)
 * — predicate/evidence_memory_id, not relation_type/source_memory_id; content/
 * type/created_at for timeline entries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { makeFakeVec } from '../../src/search/search.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { EntityRepo } from '../../src/storage/entities.js';
import { EntityRelationRepo } from '../../src/storage/entity-relations.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../src/storage/db.js';

const TOKEN = 'test-entity-relations-mcp-token';

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
}

async function mcpPost(baseUrl: string, body: object): Promise<unknown> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error(`Empty MCP response (status ${res.status})`);
  for (const line of lines) {
    const src = line.startsWith('data: ') ? line.slice(6) : line;
    try {
      return JSON.parse(src);
    } catch {
      // skip non-JSON lines (SSE framing, stray log output)
    }
  }
  throw new Error(`No parseable JSON in MCP response:\n${text}`);
}

async function toolCall(baseUrl: string, name: string, args: object): Promise<{ payload: any; isError: boolean }> {
  const resp = (await mcpPost(baseUrl, {
    jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 1,
  })) as { result?: { content?: Array<{ type: string; text: string }>; isError?: boolean }; error?: unknown };
  expect(resp.error, JSON.stringify(resp.error)).toBeUndefined();
  const text = resp.result?.content?.[0]?.text ?? '{}';
  return { payload: JSON.parse(text), isError: resp.result?.isError === true };
}

describe('get_entity_related / get_entity_timeline MCP conformance (FEAT-481 SLICE-3)', () => {
  let db: DB;
  let app: FastifyInstance;
  let baseUrl: string;
  let memRepo: MemoryRepo;
  let events: MemoryEventRepo;
  let entityRepo: EntityRepo;
  let relationRepo: EntityRelationRepo;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: TOKEN, embed: buildMockEmbed() });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
    baseUrl = `http://127.0.0.1:${addr.port}`;

    memRepo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
    entityRepo = new EntityRepo(db);
    relationRepo = new EntityRelationRepo(db);
  });

  afterEach(async () => {
    await app.close();
  });

  function makeMemory(id: string, validFrom?: number): string {
    return memRepo.insertWithCreateEvent(
      {
        type: 'fact', text: `about ${id}`, normalized_text: `about ${id}`,
        repo: 'astramem-local', project: null, branch: 'main', agent: null,
        session_id: null, hash: `hash-${id}`, source_hash: null,
        valid_from: validFrom,
      },
      events,
    ).id;
  }

  describe('get_entity_related', () => {
    it('happy path: returns relationships field-for-field matching cloud (id, subject_entity_id, predicate, object_entity_id, evidence_memory_id, source_excerpt, confidence, valid_from, valid_to)', async () => {
      const memId = makeMemory('m1', Date.now() - 10_000);
      const aliceId = entityRepo.upsert('alice', 'actor');
      const bobId = entityRepo.upsert('bob', 'actor');
      const { id: relId } = relationRepo.insert({
        subjectEntityId: aliceId, predicate: 'owned_by', objectEntityId: bobId,
        evidenceMemoryId: memId, sourceExcerpt: 'alice owns the deploy script',
        confidence: 0.8, validFrom: Date.now() - 10_000,
      });

      const { payload, isError } = await toolCall(baseUrl, 'get_entity_related', { entityId: aliceId });
      expect(isError).toBe(false);
      expect(payload.entity_id).toBe(aliceId);
      expect(payload.relationships).toHaveLength(1);
      expect(payload.relationships[0]).toEqual({
        id: relId,
        subject_entity_id: aliceId,
        predicate: 'owned_by',
        object_entity_id: bobId,
        evidence_memory_id: memId,
        source_excerpt: 'alice owns the deploy script',
        confidence: 0.8,
        valid_from: expect.any(Number),
        valid_to: null,
      });
    });

    it('direction filter: subject/object restrict to the matching role, both (default) returns either', async () => {
      const memId = makeMemory('m2', Date.now() - 10_000);
      const aliceId = entityRepo.upsert('alice2', 'actor');
      const bobId = entityRepo.upsert('bob2', 'actor');
      const carolId = entityRepo.upsert('carol2', 'actor');
      relationRepo.insert({
        subjectEntityId: aliceId, predicate: 'owned_by', objectEntityId: bobId,
        evidenceMemoryId: memId, sourceExcerpt: 'excerpt-1', validFrom: Date.now() - 10_000,
      });
      relationRepo.insert({
        subjectEntityId: carolId, predicate: 'assigned_to', objectEntityId: aliceId,
        evidenceMemoryId: memId, sourceExcerpt: 'excerpt-2', validFrom: Date.now() - 10_000,
      });

      const subjectOnly = await toolCall(baseUrl, 'get_entity_related', { entityId: aliceId, direction: 'subject' });
      expect(subjectOnly.payload.relationships).toHaveLength(1);
      expect(subjectOnly.payload.relationships[0].predicate).toBe('owned_by');

      const objectOnly = await toolCall(baseUrl, 'get_entity_related', { entityId: aliceId, direction: 'object' });
      expect(objectOnly.payload.relationships).toHaveLength(1);
      expect(objectOnly.payload.relationships[0].predicate).toBe('assigned_to');

      const both = await toolCall(baseUrl, 'get_entity_related', { entityId: aliceId });
      expect(both.payload.relationships).toHaveLength(2);
    });

    it('asOf excludes a relation once it passes its evidence memory\'s own valid_to (design doc §4.1 JOIN-with-memories contract)', async () => {
      const validFrom = Date.parse('2026-01-01T00:00:00Z');
      const memId = makeMemory('m-invalidated', validFrom);
      const aliceId = entityRepo.upsert('alice3', 'actor');
      const bobId = entityRepo.upsert('bob3', 'actor');
      relationRepo.insert({
        subjectEntityId: aliceId, predicate: 'owned_by', objectEntityId: bobId,
        evidenceMemoryId: memId, sourceExcerpt: 'excerpt', validFrom,
      });

      // Sanity: currently valid before invalidation, as-of a time after validFrom.
      const beforeInvalidate = await toolCall(baseUrl, 'get_entity_related', {
        entityId: aliceId, asOf: '2026-02-01T00:00:00Z',
      });
      expect(beforeInvalidate.payload.relationships).toHaveLength(1);

      events.invalidate(memId);
      const invalidatedMemory = db.prepare('SELECT valid_to FROM memories WHERE id = ?').get(memId) as { valid_to: number };
      expect(invalidatedMemory.valid_to).not.toBeNull();

      // entity_relations.valid_to itself is untouched by invalidate() — the
      // exclusion below must come from the JOIN, not this column.
      const relRow = db.prepare('SELECT valid_to FROM entity_relations WHERE evidence_memory_id = ?').get(memId) as { valid_to: number | null };
      expect(relRow.valid_to).toBeNull();

      const afterInvalidate = await toolCall(baseUrl, 'get_entity_related', {
        entityId: aliceId, asOf: new Date(invalidatedMemory.valid_to + 10_000).toISOString(),
      });
      expect(afterInvalidate.payload.relationships).toHaveLength(0);
    });

    it('limit truncates the result set (2 relations seeded, limit: 1)', async () => {
      const memId = makeMemory('m-limit', Date.now() - 10_000);
      const aliceId = entityRepo.upsert('alice-limit', 'actor');
      const entities = ['e1', 'e2'].map(n => entityRepo.upsert(n, 'actor'));
      for (const objEnt of entities) {
        relationRepo.insert({
          subjectEntityId: aliceId, predicate: 'relates_to', objectEntityId: objEnt,
          evidenceMemoryId: memId, sourceExcerpt: 'excerpt', validFrom: Date.now() - 10_000,
        });
      }
      const { payload } = await toolCall(baseUrl, 'get_entity_related', { entityId: aliceId, limit: 1 });
      expect(payload.relationships).toHaveLength(1);
    });

    it('a limit over the max (500) is rejected by the input schema, not silently clamped', async () => {
      const resp = (await mcpPost(baseUrl, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get_entity_related', arguments: { entityId: 'irrelevant', limit: 501 } },
        id: 1,
      })) as { result?: { isError?: boolean }; error?: unknown };
      // The MCP SDK surfaces a zod schema-validation failure as either a
      // JSON-RPC protocol-level error or a tool-level isError — either way,
      // limit: 501 must not be silently accepted as if it were legal.
      const rejected = resp.error !== undefined || resp.result?.isError === true;
      expect(rejected, JSON.stringify(resp)).toBe(true);
    });

    it('unknown entity returns a not-found error', async () => {
      const { payload, isError } = await toolCall(baseUrl, 'get_entity_related', { entityId: 'does-not-exist' });
      expect(isError).toBe(true);
      expect(payload).toEqual({ error: 'not found', entity_id: 'does-not-exist' });
    });

    it('an entity with zero relations returns an empty array, not an error', async () => {
      const loneId = entityRepo.upsert('lonely-entity', 'actor');
      const { payload, isError } = await toolCall(baseUrl, 'get_entity_related', { entityId: loneId });
      expect(isError).toBe(false);
      expect(payload).toEqual({ entity_id: loneId, relationships: [] });
    });
  });

  describe('get_entity_timeline', () => {
    it('happy path: returns memories mentioning the entity, field-for-field (id, content, type, created_at)', async () => {
      const entityId = entityRepo.upsert('postgres', 'tech');
      const memId = memRepo.insertWithCreateEvent(
        {
          type: 'fact', text: 'we chose postgres for storage', normalized_text: 'postgres storage',
          repo: 'astramem-local', project: null, branch: 'main', agent: null,
          session_id: null, hash: 'hash-timeline-1', source_hash: null,
        },
        events,
      ).id;
      entityRepo.link(memId, entityId);

      const { payload, isError } = await toolCall(baseUrl, 'get_entity_timeline', { entityId });
      expect(isError).toBe(false);
      expect(payload.entity_id).toBe(entityId);
      expect(payload.entity_name).toBe('postgres');
      expect(payload.count).toBe(1);
      expect(payload.memories).toEqual([
        { id: memId, content: 'we chose postgres for storage', type: 'fact', created_at: expect.any(Number) },
      ]);
    });

    it('returns memories newest-first', async () => {
      const entityId = entityRepo.upsert('redis', 'tech');
      const oldId = memRepo.insertWithCreateEvent(
        {
          type: 'fact', text: 'old redis note', normalized_text: 'old redis note',
          repo: 'astramem-local', project: null, branch: 'main', agent: null,
          session_id: null, hash: 'hash-timeline-old', source_hash: null,
        },
        events,
      ).id;
      db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(1_000, oldId);
      entityRepo.link(oldId, entityId);

      const newId = memRepo.insertWithCreateEvent(
        {
          type: 'fact', text: 'new redis note', normalized_text: 'new redis note',
          repo: 'astramem-local', project: null, branch: 'main', agent: null,
          session_id: null, hash: 'hash-timeline-new', source_hash: null,
        },
        events,
      ).id;
      db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(2_000, newId);
      entityRepo.link(newId, entityId);

      const { payload } = await toolCall(baseUrl, 'get_entity_timeline', { entityId });
      expect(payload.memories.map((m: { id: string }) => m.id)).toEqual([newId, oldId]);
    });

    it('since bound (epoch-ms) excludes memories created before it', async () => {
      const entityId = entityRepo.upsert('kafka', 'tech');
      const oldId = memRepo.insertWithCreateEvent(
        {
          type: 'fact', text: 'old kafka note', normalized_text: 'old kafka note',
          repo: 'astramem-local', project: null, branch: 'main', agent: null,
          session_id: null, hash: 'hash-since-old', source_hash: null,
        },
        events,
      ).id;
      db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(1_000, oldId);
      entityRepo.link(oldId, entityId);

      const newId = memRepo.insertWithCreateEvent(
        {
          type: 'fact', text: 'new kafka note', normalized_text: 'new kafka note',
          repo: 'astramem-local', project: null, branch: 'main', agent: null,
          session_id: null, hash: 'hash-since-new', source_hash: null,
        },
        events,
      ).id;
      db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(5_000, newId);
      entityRepo.link(newId, entityId);

      const { payload } = await toolCall(baseUrl, 'get_entity_timeline', { entityId, since: 3_000 });
      expect(payload.memories).toHaveLength(1);
      expect(payload.memories[0].id).toBe(newId);
    });

    it('unknown entity returns a not-found error', async () => {
      const { payload, isError } = await toolCall(baseUrl, 'get_entity_timeline', { entityId: 'does-not-exist' });
      expect(isError).toBe(true);
      expect(payload).toEqual({ error: 'not found', entity_id: 'does-not-exist' });
    });

    it('an entity with zero mentions returns an empty timeline, not an error', async () => {
      const loneId = entityRepo.upsert('lonely-timeline-entity', 'actor');
      const { payload, isError } = await toolCall(baseUrl, 'get_entity_timeline', { entityId: loneId });
      expect(isError).toBe(false);
      expect(payload).toEqual({ entity_id: loneId, entity_name: 'lonely-timeline-entity', count: 0, memories: [] });
    });
  });
});
