/**
 * Retrieval-overhaul Phase 5 (storage half) + Phase 6 (P6a relations[] in
 * the conversational prompt, P6b cross-atom linking) — end-to-end re-ingest
 * proof.
 *
 * This is the WT-C distill-graph "deliverable is populated data, not a
 * retrieval score" verification the dispatch calls for: run a small fixture
 * transcript through the real `runPipeline` (mocked LLM/embed providers,
 * same pattern as tests/distill/pipeline.test.ts) and assert that
 * `entity_relations`, `memory_links`, and the new `memories.evidence_*`
 * provenance columns actually get populated — not just that the pipeline
 * doesn't throw.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { runPipeline } from '../../src/distill/pipeline.js';
import type { LLMProvider, EmbedProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth, EmbedHealth } from '../../src/contracts/index.js';
import type { DB } from '../../src/storage/db.js';
import type { FixtureManifest } from '../../scripts/gen-upgrade-fixture.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEGACY_FIXTURE_DIR = join(__dirname, '..', 'storage', 'fixtures', 'datadir-v12');
const LEGACY_FIXTURE_DB = join(LEGACY_FIXTURE_DIR, 'memory.sqlite');
const LEGACY_FIXTURE_MANIFEST: FixtureManifest = JSON.parse(
  readFileSync(join(LEGACY_FIXTURE_DIR, 'manifest.json'), 'utf8'),
);

// Flattened `role: text` transcript (flatten-turns.ts's own convention) —
// both atoms' `evidence` strings below are verbatim substrings of this text
// so locate-evidence.ts's tier-1 exact match fires deterministically.
const FIXTURE_TRANSCRIPT = `user: My daughter Alice is starting kindergarten in September, she's so excited.
assistant: That's wonderful! What preschool did she attend before?
user: She went to Sunny Days for two years, it was a great fit for her.`;

// Simulates what the NOW-UPDATED conversational prompt
// (EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL, src/distill/prompts/extract.ts)
// asks the model to produce (P6a): entities[] + relations[] on the same
// atom. The mock provider below ignores the actual prompt text, so this
// fixture is exercising the STORAGE/PIPELINE wiring these atoms flow
// through, not the prompt bytes themselves (those are covered by
// tests/distill/prompt-hash-freeze.test.ts).
const EXTRACTION_RESPONSE = JSON.stringify({
  atoms: [
    {
      type: 'fact',
      text: "Sergey's daughter Alice is starting kindergarten in September.",
      importance: 0.8,
      confidence: 0.9,
      evidence: 'My daughter Alice is starting kindergarten in September',
      entities: [
        { name: 'Sergey', kind: 'actor', subtype: 'human' },
        { name: 'Alice', kind: 'actor', subtype: 'human' },
      ],
      relations: [
        { subject: 'Alice', predicate: 'relates_to', object: 'Sergey', confidence: 0.9 },
      ],
    },
    {
      type: 'fact',
      text: 'Alice attended Sunny Days preschool for two years.',
      importance: 0.5,
      confidence: 0.85,
      evidence: 'She went to Sunny Days for two years',
      entities: [
        { name: 'Alice', kind: 'actor', subtype: 'human' },
        { name: 'Sunny Days', kind: 'other' },
      ],
    },
  ],
});

function makeMockLLM(): LLMProvider {
  return {
    name: 'ollama' as const,
    model: 'test-model',
    async chat(_msgs: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
      const reply = opts?.json ? EXTRACTION_RESPONSE : 'compressed content';
      return { text: reply, usage: { in: 100, out: 50, usd: 0 } };
    },
    async health(): Promise<LLMHealth> {
      return { ok: true, model: 'test-model', latency_ms: 0 };
    },
  };
}

function makeMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'test-embed',
    dim: 1024 as const,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((_, i) => {
        const v = new Float32Array(1024);
        for (let j = 0; j < 1024; j++) v[j] = Math.sin(i + j * 0.01);
        return v;
      });
    },
    async health(): Promise<EmbedHealth> {
      return { ok: true, model: 'test-embed', dim: 1024 };
    },
  };
}

describe('retrieval-overhaul Phase 5 (storage) + Phase 6 (graph population) — re-ingest proof', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('before: entity_relations and memory_links are empty on a fresh DB', () => {
    const relCount = (db.prepare('SELECT COUNT(*) AS n FROM entity_relations').get() as { n: number }).n;
    const linkCount = (db.prepare('SELECT COUNT(*) AS n FROM memory_links').get() as { n: number }).n;
    expect(relCount).toBe(0);
    expect(linkCount).toBe(0);
  });

  it('after re-ingest: entity_relations gains rows from the atom-level relations[] (P6a)', async () => {
    const llm = makeMockLLM();
    const embed = makeMockEmbed();

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      extractProfile: 'conversational',
    });

    const rows = db.prepare('SELECT predicate, source_excerpt FROM entity_relations').all() as
      Array<{ predicate: string; source_excerpt: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => r.predicate === 'relates_to')).toBe(true);
  });

  it('after re-ingest: memory_links gains a cross-atom row for the entity Alice shares across both atoms (P6b)', async () => {
    const llm = makeMockLLM();
    const embed = makeMockEmbed();

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      extractProfile: 'conversational',
    });

    const links = db.prepare('SELECT link_type, evidence, confidence FROM memory_links').all() as
      Array<{ link_type: string; evidence: string; confidence: number }>;
    expect(links.length).toBeGreaterThan(0);
    // "Sergey's daughter Alice" in atom 1's own text trips the family-
    // relation detector (link-atoms.ts), so the Alice-shared pair is
    // upgraded from plain 'shared_entity' to 'possession_family'.
    expect(links.some(l => l.link_type === 'possession_family' && l.evidence === 'alice')).toBe(true);

    // Every link row carries non-empty provenance (plan requirement:
    // "require provenance for every generated edge").
    for (const link of links) {
      expect(link.evidence.length).toBeGreaterThan(0);
      expect(link.confidence).toBeGreaterThan(0);
    }
  });

  it('after re-ingest: memories carry structured evidence provenance (P5-storage) — a real located span, not just the raw evidence string', async () => {
    const llm = makeMockLLM();
    const embed = makeMockEmbed();

    await runPipeline(FIXTURE_TRANSCRIPT, {
      db, llmCompaction: llm, llmExtraction: llm, embed,
      capUsd: 10.0, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      extractProfile: 'conversational',
    });

    const rows = db.prepare(`
      SELECT text, evidence, evidence_turn_index, evidence_char_start, evidence_char_end, evidence_span
      FROM memories
    `).all() as Array<{
      text: string; evidence: string | null;
      evidence_turn_index: number | null; evidence_char_start: number | null;
      evidence_char_end: number | null; evidence_span: string | null;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const aliceKindergarten = rows.find(r => r.text.includes('kindergarten'));
    expect(aliceKindergarten).toBeDefined();
    expect(aliceKindergarten!.evidence_turn_index).toBe(0); // first transcript line
    expect(aliceKindergarten!.evidence_span).toBe('My daughter Alice is starting kindergarten in September');
    expect(aliceKindergarten!.evidence_char_start).toBeGreaterThanOrEqual(0);
    expect(aliceKindergarten!.evidence_char_end).toBeGreaterThan(aliceKindergarten!.evidence_char_start!);

    const sunnyDays = rows.find(r => r.text.includes('Sunny Days'));
    expect(sunnyDays).toBeDefined();
    expect(sunnyDays!.evidence_turn_index).toBe(2); // third transcript line
    expect(sunnyDays!.evidence_span).toBe('She went to Sunny Days for two years');
  });
});

describe('migrations 056/057 are safe on a legacy (pre-Phase-5/6) datadir', () => {
  it('a frozen schema-v12 fixture migrates cleanly to current, with existing rows getting NULL provenance/no new links', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astra-p5p6-upgrade-'));
    const dbPath = join(dir, 'memory.sqlite');
    copyFileSync(LEGACY_FIXTURE_DB, dbPath);

    const db = openDb(dbPath);
    // The migration itself must not throw — ADD COLUMN / CREATE TABLE only,
    // no rewrite of existing rows.
    expect(() => migrate(db)).not.toThrow();

    // Zero data loss (mirrors tests/storage/upgrade-path.test.ts AC-1).
    const memoryCount = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    expect(memoryCount).toBe(LEGACY_FIXTURE_MANIFEST.counts.memories);

    // Every pre-existing row has NULL for all four new provenance columns —
    // migration 057 is additive-only, never backfilled.
    const nonNullProvenance = (db.prepare(`
      SELECT COUNT(*) AS n FROM memories
      WHERE evidence_turn_index IS NOT NULL OR evidence_char_start IS NOT NULL
         OR evidence_char_end IS NOT NULL OR evidence_span IS NOT NULL
    `).get() as { n: number }).n;
    expect(nonNullProvenance).toBe(0);

    // memory_links (migration 056) exists and is empty — nothing back-fills
    // links for pre-existing atoms; only a fresh distill run populates it.
    const linkCount = (db.prepare('SELECT COUNT(*) AS n FROM memory_links').get() as { n: number }).n;
    expect(linkCount).toBe(0);

    db.close();
  });
});
