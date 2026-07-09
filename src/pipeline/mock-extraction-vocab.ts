/**
 * FEAT-414: single source of truth for the MockLLMProvider's deterministic
 * extraction vocabulary (see src/pipeline/mock-providers.ts).
 *
 * Previously the keyword -> atom-type -> entity table lived only inside
 * mock-providers.ts, and tests/smoke/_fixtures/session-canonical.json had to
 * be kept in lockstep by hand — enforced only by doc comments. A keyword
 * edit on either side would silently false-negative the smoke suite instead
 * of failing loudly.
 *
 * This module is the ONLY place the vocabulary is declared. mock-providers.ts
 * consumes it to build extraction atoms; tests/hygiene/mock-vocab-fixture-lockstep.test.ts
 * consumes it to assert the smoke fixture still triggers every rule. Edit
 * exactly one array here and both sides move together — drift becomes a
 * failing test, not silence.
 *
 * TEST-ONLY: exclusively reachable via ASTRA_MEMORY_MOCK_PROVIDERS=1
 * (CI/test only — real serving never sets it). Not a production code path.
 */

export interface MockExtractionAtom {
  type: 'decision' | 'fact' | 'todo' | 'note';
  text: string;
  importance: number;
  confidence: number;
  evidence?: string;
  entities?: Array<{ name: string; kind: string; subtype?: 'human' | 'ai' }>;
}

export interface MockExtractionRule {
  /** Human-readable id for this rule (used in test failure messages). */
  id: string;
  /**
   * Case-insensitive substring(s) matched against the full extraction input.
   * A rule fires if ANY of its keywords is present (matches original
   * `a || b` semantics for the sqlite-vec rule).
   */
  keywords: string[];
  /** Atom appended verbatim when the rule fires. */
  atom: MockExtractionAtom;
}

/**
 * Order matches the original mock-providers.ts if-chain (ORIGINAL sqlite-vec
 * rule first, byte-identical since before SLICE-SMOKE-1) so the emitted
 * atoms array stays byte-for-byte identical to pre-refactor output.
 */
export const MOCK_EXTRACTION_VOCAB: readonly MockExtractionRule[] = [
  {
    id: 'sqlite-vec',
    keywords: ['sqlite-vec', 'sqlite_vec'],
    atom: {
      type: 'decision',
      text: 'use sqlite-vec for v1 vector storage',
      importance: 0.9,
      confidence: 0.9,
      evidence: 'OK let\'s go with sqlite-vec',
    },
  },
  {
    id: 'priya-nair',
    keywords: ['priya nair'],
    atom: {
      type: 'fact',
      text: 'Priya Nair is the designated reviewer for this work',
      importance: 0.5,
      confidence: 0.8,
      // atom@2: person -> actor (subtype: human) — see src/contracts/entity.ts.
      entities: [{ name: 'Priya Nair', kind: 'actor', subtype: 'human' }],
    },
  },
  {
    id: 'astramemory-local',
    keywords: ['astramemory-local'],
    atom: {
      type: 'fact',
      text: 'This work belongs to the astramemory-local repo',
      importance: 0.5,
      confidence: 0.8,
      // atom@2: repo -> product (repo/project identity is owned by the
      // structural provenance.project field, not an entity kind).
      entities: [{ name: 'astramemory-local', kind: 'product' }],
    },
  },
  {
    id: 'typescript',
    keywords: ['typescript'],
    atom: {
      type: 'fact',
      text: 'This project is written in TypeScript',
      importance: 0.5,
      confidence: 0.8,
      entities: [{ name: 'TypeScript', kind: 'tech' }],
    },
  },
  {
    id: 'todo',
    keywords: ['todo:'],
    atom: {
      type: 'todo',
      text: 'Write a migration guide before shipping',
      importance: 0.6,
      confidence: 0.8,
    },
  },
  {
    id: 'prefers-markdown-summaries',
    keywords: ['prefers markdown summaries'],
    atom: {
      type: 'note',
      text: 'Prefers markdown-formatted memory summaries',
      importance: 0.4,
      confidence: 0.7,
    },
  },
];
