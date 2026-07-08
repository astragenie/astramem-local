/**
 * Deterministic synthetic-memory corpus generator for the perf harness.
 * Seeded PRNG so re-running `seed.mts` for the same N is reproducible and
 * the (skip-if-exists) manifest check stays meaningful across runs.
 */

const MEMORY_TYPES = [
  'decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event',
  'preference', 'task_result', 'summary',
] as const;

const REPOS = ['astramemory-local', 'astramem-plugin', 'memory-saas', 'gstack', 'crew-runner'];
const PROJECTS = ['FEAT-4a', 'FEAT-429', 'FEAT-438', 'ADR-005', 'perf-harness', 'loop-infra'];
const AGENTS = ['claude-code', 'crew-builder', 'crew-reviewer', 'crew-validator', 'longmemeval-harness'];
const BRANCHES = ['main', 'feat/stable-infra-plus-b1', 'feat/install-daemon-hardening', null];

// Vocabulary pools per type so generated text reads as plausible engineering
// memory content and produces realistic FTS token distributions (not just
// "text N" filler, which would make BM25 scoring meaningless).
const SUBJECTS = [
  'the sqlite-vec fusion query', 'the embed dim migration', 'the bearer token rotation',
  'the schtasks keepalive watchdog', 'the FTS5 escape helper', 'the recall pack budget',
  'the idempotency key hashing', 'the config reload guard', 'the entity resolver',
  'the usefulness epsilon weight', 'the distill worker concurrency', 'the redaction stage',
  'the session digest query', 'the agent profile aggregation', 'the reembed-dim CLI',
  'the vec0 KNN scan', 'the wire version regex', 'the ingest idempotency backfill',
  'the search debug dashboard', 'the consolidation proposal flow',
];
const VERBS: Record<(typeof MEMORY_TYPES)[number], string[]> = {
  decision: ['decided to use', 'chose', 'settled on', 'picked'],
  fact: ['confirmed that', 'verified that', 'observed that', 'measured that'],
  lesson: ['learned that', 'discovered the hard way that', 'found out that'],
  command: ['ran', 'executed', 'invoked'],
  todo: ['still need to fix', 'must revisit', 'left a TODO to check'],
  note: ['noted that', 'flagged that', 'wrote down that'],
  event: ['triggered', 'observed an event where', 'saw'],
  preference: ['prefers', 'always wants', 'likes'],
  task_result: ['completed', 'finished', 'shipped'],
  summary: ['summarized', 'wrapped up', 'concluded'],
};

export interface SyntheticMemory {
  text: string;
  type: (typeof MEMORY_TYPES)[number];
  metadata: {
    repo?: string;
    project?: string;
    branch?: string;
    agent?: string;
    importance?: number;
    confidence?: number;
  };
}

/** Mulberry32 — tiny deterministic PRNG, no dependency. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

export function generateCorpus(n: number, seed = 1337): SyntheticMemory[] {
  const rng = mulberry32(seed);
  const out: SyntheticMemory[] = [];
  for (let i = 0; i < n; i++) {
    const type = pick(rng, MEMORY_TYPES);
    const subject = pick(rng, SUBJECTS);
    const verb = pick(rng, VERBS[type]);
    const text = `${verb} ${subject} (item ${i}, batch ${Math.floor(i / 500)}) — ${
      pick(rng, ['see PR', 'ref commit', 'per ADR', 'via slice'])
    } ${Math.floor(rng() * 999)}`;
    out.push({
      text,
      type,
      metadata: {
        repo: pick(rng, REPOS),
        project: pick(rng, PROJECTS),
        branch: pick(rng, BRANCHES) ?? undefined,
        agent: pick(rng, AGENTS),
        importance: Math.round(rng() * 100) / 100,
        confidence: Math.round(rng() * 100) / 100,
      },
    });
  }
  return out;
}

/** Fixed, varied query set used for GET /search and POST /recall benchmarks —
 *  mixes single-token, multi-token, and subject-phrase queries so results
 *  exercise both FTS and vector legs realistically. */
export const BENCH_QUERIES: string[] = [
  'sqlite-vec fusion query',
  'embed dim migration',
  'bearer token rotation',
  'keepalive watchdog',
  'recall pack budget',
  'idempotency key hashing',
  'entity resolver',
  'distill worker concurrency',
  'redaction stage',
  'session digest',
];

export { MEMORY_TYPES, REPOS, PROJECTS, AGENTS };
