# Wave 1/2 Amendments + Killer Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three review amendments (AM-1 evidence persistence, AM-2 fusion fix, AM-3 version drift) and three killer features (KF-A `why_memory` receipts, KF-C session digest, KF-B proactive memory-pack) per the approved design.

**Architecture:** Additive changes to the existing daemon: one SQL migration (004), evidence threaded to storage, two new REST routes, three new MCP tools, one new selection module for memory packs. No changes to the 8-stage pipeline order, job semantics, or search fusion formula (only its edge case).

**Tech Stack:** TypeScript ESM, better-sqlite3, sqlite-vec, Fastify 5, `@modelcontextprotocol/sdk`, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-07-02-wave1-2-amendments-killer-features-design.md`

## Global Constraints

- Node >= 20; ESM only — all relative imports end in `.js`.
- Embedding dim pinned to 1024 (`FLOAT[1024]` vec table) — do not touch.
- New migration REQUIRES bumping `SCHEMA_VERSION` in `src/server/lib/wire-meta.ts` (boot-time drift guard throws otherwise).
- Memory types: `'decision' | 'fact' | 'lesson' | 'command' | 'todo' | 'note' | 'event'`.
- Run tests with `npm test` (vitest run) from repo root; all existing tests must stay green.
- Commit after every task; conventional-commit style messages.
- Work on branch `docs/wave1-2-amendments-design` (already exists) or a new `feat/wave1-2-amendments` branch off it.

---

### Task 1: AM-2 — Fusion normalization edge case

**Files:**
- Modify: `src/search/fuse.ts:24-31` (`normalizeScores`)
- Test: `tests/search/fuse.test.ts` (existing test flips)

**Interfaces:**
- Produces: `normalizeScores(scores: number[]): number[]` — unchanged signature; new behavior: all-equal non-empty input returns all `1.0` (was all `0`).

- [ ] **Step 1: Flip the existing test + add single-hit case**

In `tests/search/fuse.test.ts`, replace the `'all-same → all 0'` test with:

```typescript
  it('all-same non-empty → all 1.0 (equal scores are equally best; signal preserved)', () => {
    const out = normalizeScores([3, 3, 3]);
    expect(out).toEqual([1, 1, 1]);
  });

  it('single hit → 1.0 (a lone FTS/vec hit must not lose its component signal)', () => {
    expect(normalizeScores([7])).toEqual([1]);
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test -- tests/search/fuse.test.ts`
Expected: 2 FAIL (`expected [0,0,0] to equal [1,1,1]`, `expected [0] to equal [1]`), rest pass.

- [ ] **Step 3: Implement the fix**

In `src/search/fuse.ts`, change `normalizeScores`:

```typescript
export function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  // All-equal (including single-hit): every score is equally the best match
  // within this component. Returning 0 would erase the component's signal
  // entirely (a lone FTS hit would lose its whole BM25 contribution).
  if (range === 0) return scores.map(() => 1);
  return scores.map(s => (s - min) / range);
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all PASS (no other test asserts the all-zero behavior; if one does, update it with the same rationale).

- [ ] **Step 5: Commit**

```bash
git add src/search/fuse.ts tests/search/fuse.test.ts
git commit -m "fix(search): all-equal scores normalize to 1.0, not 0 — preserves single-hit signal"
```

---

### Task 2: AM-3 — DAEMON_VERSION drift

**Files:**
- Modify: `src/mcp/server.ts:25-26,43`
- Test: `tests/mcp/version.test.ts` (create)

**Interfaces:**
- Consumes: `PKG_VERSION: string` from `src/server/lib/wire-meta.ts` (already exists, reads package.json once at module load).

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/version.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PKG_VERSION } from '../../src/server/lib/wire-meta.js';

describe('MCP server version', () => {
  it('mcp/server.ts carries no hardcoded DAEMON_VERSION literal', () => {
    const src = readFileSync(join(__dirname, '../../src/mcp/server.ts'), 'utf8');
    expect(src).not.toMatch(/DAEMON_VERSION\s*=\s*'\d/);
    expect(src).toContain('PKG_VERSION');
  });

  it('PKG_VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
    expect(PKG_VERSION).toBe(pkg.version);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/mcp/version.test.ts`
Expected: FAIL — source still matches `DAEMON_VERSION = '0.1.4'`.

- [ ] **Step 3: Implement**

In `src/mcp/server.ts`: delete the `const DAEMON_VERSION = '0.1.4';` line (and its comment), add import, and use it:

```typescript
import { PKG_VERSION } from '../server/lib/wire-meta.js';
```

```typescript
  const server = new McpServer(
    { name: 'astramemory-local', version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/mcp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts tests/mcp/version.test.ts
git commit -m "fix(mcp): derive server version from package.json via PKG_VERSION (was hardcoded 0.1.4)"
```

---

### Task 3: AM-1 — Persist evidence (migration 004 + thread-through)

**Files:**
- Create: `migrations/004-provenance.sql`
- Modify: `src/server/lib/wire-meta.ts:36` (`SCHEMA_VERSION` 3 → 4)
- Modify: `src/contracts/memory.ts` (add `evidence`)
- Modify: `src/storage/memories.ts` (`InsertInput` + insert SQL)
- Modify: `src/distill/stages/08-embed-index.ts:69-85` (pass `mem.evidence`)
- Test: `tests/storage/evidence.test.ts` (create)

**Interfaces:**
- Consumes: `NormalizedMemory` already carries `evidence?: string` (inherited from `Atom` via `ReducedAtom` — spread in stages 6/7 preserves it; nothing to change in the pipeline stages).
- Produces: `memories.evidence TEXT` column; `Memory.evidence: string | null`; `InsertInput.evidence?: string | null`. Task 4 (`why_memory`) reads `Memory.evidence`.

- [ ] **Step 1: Write the failing test**

Create `tests/storage/evidence.test.ts`. Follow the DB-fixture pattern used in `tests/storage/` (in-memory DB + `migrate(db)` — copy the setup lines from an existing test in that directory, e.g. the memories repo test):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { embedAndIndex } from '../../src/distill/stages/08-embed-index.js';
import { makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';

function fakeEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'fake',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'fake', dim: 1024 as const }),
  };
}

describe('evidence persistence (AM-1)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('insert stores evidence and get returns it', () => {
    const repo = new MemoryRepo(db);
    const id = repo.insert({
      type: 'decision',
      text: 'Use SQLite, not Postgres',
      normalized_text: 'use SQLite, not PostgreSQL',
      repo: 'astramem-local', project: null, branch: null, agent: null,
      session_id: null, hash: 'h-evidence-1', source_hash: null,
      evidence: 'we decided sqlite because zero-config local file',
    });
    const mem = repo.get(id);
    expect(mem?.evidence).toBe('we decided sqlite because zero-config local file');
  });

  it('insert without evidence stores null (old-row degradation)', () => {
    const repo = new MemoryRepo(db);
    const id = repo.insert({
      type: 'fact', text: 'port 7777 default', normalized_text: 'port 7777 default',
      repo: null, project: null, branch: null, agent: null,
      session_id: null, hash: 'h-evidence-2', source_hash: null,
    });
    expect(repo.get(id)?.evidence).toBeNull();
  });

  it('stage 8 (embedAndIndex) passes evidence through to storage', async () => {
    const results = await embedAndIndex(
      [{
        type: 'lesson',
        text: 'Bun lacks better-sqlite3 on Windows',
        importance: 0.8,
        confidence: 0.9,
        evidence: 'install failed with node-gyp error in session log',
        contentHash: 'ch-1',
        normalizedText: 'Bun lacks better-sqlite3 on Windows',
        finalHash: 'h-evidence-3',
      }],
      {
        db, embed: fakeEmbed(),
        sessionId: null, repo: 'r1', project: null, branch: null, agent: null,
        sourceHash: null,
      },
    );
    expect(results).toHaveLength(1);
    const stored = new MemoryRepo(db).get(results[0]!.memoryId);
    expect(stored?.evidence).toBe('install failed with node-gyp error in session log');
  });
});
```

Fixture APIs above (`openDb(':memory:')`, `EmbedProvider` shape, `makeFakeVec`) are verified against `tests/storage/memories.test.ts` and `src/server/app.ts`'s noop provider — they are current as of v0.3.4.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/storage/evidence.test.ts`
Expected: FAIL — either schema-drift error (migration missing) or `evidence` undefined/TS error.

- [ ] **Step 3: Create the migration + bump SCHEMA_VERSION**

Create `migrations/004-provenance.sql`:

```sql
-- AM-1: persist stage-5 extraction evidence (provenance receipts).
-- Nullable: rows created before v0.4.0 have no evidence — why_memory
-- degrades gracefully. See design doc 2026-07-02 §2/§3.
ALTER TABLE memories ADD COLUMN evidence TEXT;
```

In `src/server/lib/wire-meta.ts` change:

```typescript
export const SCHEMA_VERSION = 4 as const;
```

- [ ] **Step 4: Thread evidence through contracts + repo + stage 8**

`src/contracts/memory.ts` — add to `Memory`:

```typescript
  evidence: string | null;
```

`src/storage/memories.ts` — add to `InsertInput`:

```typescript
  evidence?: string | null;
```

and change the insert to include it:

```typescript
    this.db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, repo, project, branch, agent, session_id,
         importance, confidence, hash, embedding_provider, embedding_model, embedding_dim,
         created_at, updated_at, source_hash, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.type, input.text, input.normalized_text,
      input.repo, input.project, input.branch, input.agent, input.session_id,
      input.importance ?? 0.5, input.confidence ?? 0.5, input.hash,
      input.embedding_provider ?? null, input.embedding_model ?? null, input.embedding_dim ?? null,
      now, now, input.source_hash, input.evidence ?? null
    );
```

`src/distill/stages/08-embed-index.ts` — in the `memRepo.insert({...})` call add one line:

```typescript
      evidence: mem.evidence ?? null,
```

(`mem` is `NormalizedMemory`, which inherits `evidence?: string` from `Atom` — stages 6/7 already preserve it via object spread; no pipeline change needed.)

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: `tests/storage/evidence.test.ts` PASS; full suite green (the drift guard now sees migration 004 + constant 4).

- [ ] **Step 6: Commit**

```bash
git add migrations/004-provenance.sql src/server/lib/wire-meta.ts src/contracts/memory.ts src/storage/memories.ts src/distill/stages/08-embed-index.ts tests/storage/evidence.test.ts
git commit -m "feat(storage): migration 004 — persist extraction evidence (provenance, AM-1)"
```

---

### Task 4: KF-A — `why_memory` provenance receipts (REST + MCP)

**Files:**
- Create: `src/server/routes/why.ts`
- Modify: `src/server/app.ts` (add import + `await app.register(whyRoute(opts.db));` next to the existing `memoryRoute` registration)
- Modify: `src/mcp/server.ts` (register `why_memory` tool after `get_health`)
- Test: `tests/server/why.test.ts` (create)

**Interfaces:**
- Consumes: `Memory.evidence: string | null` (Task 3); `MemoryRepo.get(id)`; `sessions` columns `id, repo, project, branch, agent, started_at`.
- Produces: receipt shape used by both surfaces (Task 5/6 do not depend on it):

```typescript
interface MemoryReceipt {
  id: string; type: string; text: string;
  importance: number; confidence: number;
  evidence: string | null;
  session: { id: string; repo: string | null; branch: string | null; agent: string | null; started_at: number } | null;
  transcript_ref: string | null;   // memories.source_hash
  created_at: number;
  history: never[];                // reserved for Wave 2a supersession chain — always [] in v1
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/server/why.test.ts` (fixture pattern: copy the DB + `buildApp` setup from an existing test in `tests/server/`; requests need header `authorization: Bearer <token>` matching the token passed to `buildApp`):

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { buildApp } from '../../src/server/app.js';

describe('GET /memory/:id/why (KF-A)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('returns a receipt with evidence + session block', async () => {
    db.prepare(
      'INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('s1', 'astramem-local', null, 'main', 'claude-code', 1000);
    const id = new MemoryRepo(db).insert({
      type: 'decision', text: 'Use SQLite', normalized_text: 'use SQLite',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: 's1', hash: 'h-why-1', source_hash: 'src-abc',
      evidence: 'zero-config local file decided in review',
    });

    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({
      method: 'GET', url: `/memory/${id}/why`,
      headers: { authorization: 'Bearer t' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.evidence).toBe('zero-config local file decided in review');
    expect(body.session).toMatchObject({ id: 's1', repo: 'astramem-local' });
    expect(body.transcript_ref).toBe('src-abc');
    expect(body.history).toEqual([]);
  });

  it('null-session memory → receipt without session block', async () => {
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'port 7777', normalized_text: 'port 7777',
      repo: null, project: null, branch: null, agent: null,
      session_id: null, hash: 'h-why-2', source_hash: null,
    });
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({
      method: 'GET', url: `/memory/${id}/why`,
      headers: { authorization: 'Bearer t' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().session).toBeNull();
    expect(res.json().evidence).toBeNull();
  });

  it('unknown id → 404', async () => {
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({
      method: 'GET', url: '/memory/nope/why',
      headers: { authorization: 'Bearer t' },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/why.test.ts`
Expected: FAIL — 404 on the happy path (route not registered yet).

- [ ] **Step 3: Implement the route**

Create `src/server/routes/why.ts`:

```typescript
/**
 * Provenance receipt route (KF-A):
 *   GET /memory/:id/why — memory + evidence + source session + transcript ref.
 * `history` is reserved for the Wave 2a supersession chain; always [] in v1.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { MemoryRepo } from '../../storage/memories.js';

interface SessionBlock {
  id: string;
  repo: string | null;
  branch: string | null;
  agent: string | null;
  started_at: number;
}

export function whyRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.get('/memory/:id/why', async (req, reply) => {
      const { id } = req.params as { id: string };
      const memory = new MemoryRepo(db).get(id);
      if (!memory) {
        return reply.code(404).send({ error: 'not found', id });
      }

      let session: SessionBlock | null = null;
      if (memory.session_id) {
        session = (db
          .prepare('SELECT id, repo, branch, agent, started_at FROM sessions WHERE id = ?')
          .get(memory.session_id) as SessionBlock | undefined) ?? null;
      }

      return {
        id: memory.id,
        type: memory.type,
        text: memory.text,
        importance: memory.importance,
        confidence: memory.confidence,
        evidence: memory.evidence,
        session,
        transcript_ref: memory.source_hash,
        created_at: memory.created_at,
        history: [] as never[],
      };
    });
  };
}
```

In `src/server/app.ts` add the import and register next to `memoryRoute`:

```typescript
import { whyRoute } from './routes/why.js';
```

```typescript
  await app.register(whyRoute(opts.db));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/server/why.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register the MCP tool**

In `src/mcp/server.ts`, after the `get_health` registration, add (MCP tools call the service layer directly — no HTTP self-call, matching the file's existing pattern):

```typescript
  // ---- why_memory ----------------------------------------------------------
  server.registerTool(
    'why_memory',
    {
      description:
        'Provenance receipt for a memory: evidence excerpt, source session, transcript ref. Answers: why do I remember this?',
      inputSchema: z.object({
        id: z.string().min(1).describe('Memory id'),
      }),
    },
    async (args) => {
      const memRepo = new MemoryRepo(db);
      const memory = memRepo.get(args.id);
      if (!memory) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', id: args.id }) }],
          isError: true,
        };
      }
      let session: unknown = null;
      if (memory.session_id) {
        session = db
          .prepare('SELECT id, repo, branch, agent, started_at FROM sessions WHERE id = ?')
          .get(memory.session_id) ?? null;
      }
      const receipt = {
        id: memory.id, type: memory.type, text: memory.text,
        importance: memory.importance, confidence: memory.confidence,
        evidence: memory.evidence, session,
        transcript_ref: memory.source_hash, created_at: memory.created_at,
        history: [],
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(receipt) }] };
    }
  );
```

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/why.ts src/server/app.ts src/mcp/server.ts tests/server/why.test.ts
git commit -m "feat(provenance): why_memory receipts - GET /memory/:id/why + MCP tool (KF-A)"
```

---

### Task 5: KF-C — Session digest (read-time derivation)

> **Design deviation (intentional):** the spec proposed persisting a digest `artifacts` row. The `artifacts` table stores `content_path` (file paths, not JSON) and `JobHandler.handle` never receives its `job_id`, so persisting would need schema or handler-contract changes. The digest is instead **derived at read time** from `memories WHERE session_id = ?` — zero new state, same product surface. Pending detection uses the `jobs` table.

**Files:**
- Create: `src/server/routes/digest.ts`
- Modify: `src/server/app.ts` (register route)
- Modify: `src/mcp/server.ts` (register `session_digest` tool)
- Test: `tests/server/digest.test.ts` (create)

**Interfaces:**
- Consumes: `memories` columns `id, type, text, created_at, session_id`; `jobs` columns `kind, state, payload_json`.
- Produces digest shape:

```typescript
interface SessionDigest {
  session_id: string;
  status: 'ready' | 'pending';   // pending = a distill job for this session is queued/running
  counts: Record<string, number>; // per memory type, only types present
  memories: Array<{ id: string; type: string; text: string }>;
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/server/digest.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { buildApp } from '../../src/server/app.js';

function seedSession(db: DB, id: string) {
  db.prepare(
    'INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, 'astramem-local', null, 'main', 'claude-code', Date.now());
}

describe('GET /sessions/:id/digest (KF-C)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('returns per-type counts + memory texts for the session', async () => {
    seedSession(db, 's1');
    const repo = new MemoryRepo(db);
    repo.insert({ type: 'decision', text: 'Use SQLite', normalized_text: 'use SQLite',
      repo: 'r', project: null, branch: null, agent: null, session_id: 's1',
      hash: 'd1', source_hash: null });
    repo.insert({ type: 'lesson', text: 'Bun lacks better-sqlite3 on Windows', normalized_text: 'bun lacks',
      repo: 'r', project: null, branch: null, agent: null, session_id: 's1',
      hash: 'd2', source_hash: null });

    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/sessions/s1/digest',
      headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.counts).toEqual({ decision: 1, lesson: 1 });
    expect(body.memories).toHaveLength(2);
  });

  it('distill job still queued → status pending', async () => {
    seedSession(db, 's2');
    db.prepare(
      'INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
    ).run('j1', 'distill', JSON.stringify({ transcript_id: 't1', session_id: 's2' }), 'pending', Date.now(), Date.now());

    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/sessions/s2/digest',
      headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending');
  });

  it('unknown session → 404', async () => {
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({ method: 'GET', url: '/sessions/nope/digest',
      headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/digest.test.ts`
Expected: FAIL — 404 everywhere (route missing).

- [ ] **Step 3: Implement the route**

Create `src/server/routes/digest.ts`:

```typescript
/**
 * Session digest route (KF-C): "what I learned this session".
 *   GET /sessions/:id/digest
 * Derived at read time from memories(session_id); no stored digest state.
 * status=pending while a distill job for this session is queued/running.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';

interface MemRow { id: string; type: string; text: string }

export function digestRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.get('/sessions/:id/digest', async (req, reply) => {
      const { id } = req.params as { id: string };

      const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
      if (!session) {
        return reply.code(404).send({ error: 'not found', session_id: id });
      }

      // A distill job for this session still queued or running → pending.
      // payload_json is small ({transcript_id, session_id}); LIKE match is safe here.
      const activeJob = db.prepare(`
        SELECT id FROM jobs
        WHERE kind = 'distill' AND state IN ('pending', 'running')
          AND payload_json LIKE ?
        LIMIT 1
      `).get(`%"session_id":"${id}"%`);

      const rows = db.prepare(
        'SELECT id, type, text FROM memories WHERE session_id = ? ORDER BY created_at ASC'
      ).all(id) as MemRow[];

      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.type] = (counts[r.type] ?? 0) + 1;

      return {
        session_id: id,
        status: activeJob ? 'pending' : 'ready',
        counts,
        memories: rows,
      };
    });
  };
}
```

In `src/server/app.ts` add:

```typescript
import { digestRoute } from './routes/digest.js';
```

```typescript
  await app.register(digestRoute(opts.db));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/server/digest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register the MCP tool**

In `src/mcp/server.ts` add after `why_memory` (session_id optional — defaults to the most recently started session):

```typescript
  // ---- session_digest ------------------------------------------------------
  server.registerTool(
    'session_digest',
    {
      description:
        'What I learned this session: per-type counts + texts of memories formed. Defaults to the latest session.',
      inputSchema: z.object({
        session_id: z.string().optional().describe('Session id; defaults to most recent session'),
      }),
    },
    async (args) => {
      let sessionId = args.session_id;
      if (!sessionId) {
        const latest = db
          .prepare('SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1')
          .get() as { id: string } | undefined;
        if (!latest) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'no sessions recorded' }) }],
            isError: true,
          };
        }
        sessionId = latest.id;
      }
      const activeJob = db.prepare(`
        SELECT id FROM jobs
        WHERE kind = 'distill' AND state IN ('pending', 'running')
          AND payload_json LIKE ?
        LIMIT 1
      `).get(`%"session_id":"${sessionId}"%`);
      const rows = db.prepare(
        'SELECT id, type, text FROM memories WHERE session_id = ? ORDER BY created_at ASC'
      ).all(sessionId) as Array<{ id: string; type: string; text: string }>;
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.type] = (counts[r.type] ?? 0) + 1;
      const digest = {
        session_id: sessionId,
        status: activeJob ? 'pending' : 'ready',
        counts,
        memories: rows,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(digest) }] };
    }
  );
```

- [ ] **Step 6: Run full suite + commit**

Run: `npm test`
Expected: all PASS.

```bash
git add src/server/routes/digest.ts src/server/app.ts src/mcp/server.ts tests/server/digest.test.ts
git commit -m "feat(digest): session digest - GET /sessions/:id/digest + MCP session_digest (KF-C)"
```

---

### Task 6: KF-B — Memory-pack selection + `/recall/pack` endpoint + hook doc

> **Scope note:** the endpoint + selection module + install doc ship here. Auto-install via the `init` wizard is deferred to Wave 2f launch polish (manual install per the doc works today); the `config.recallPack.enabled` flag exists for that wizard to flip.

**Files:**
- Create: `src/recall/pack.ts`
- Create: `src/server/routes/recall.ts`
- Modify: `src/server/app.ts` (register route)
- Modify: `src/config/config.ts` (add `recallPack`)
- Create: `docs/hooks/memory-pack.md`
- Test: `tests/recall/pack.test.ts` (create)

**Interfaces:**
- Consumes: `memories` columns `id, type, text, importance, created_at, repo`.
- Produces:

```typescript
// src/recall/pack.ts
export interface PackOptions {
  repo: string;
  project?: string | null;
  branch?: string | null;
  budgetTokens?: number;          // default from config.recallPack.budgetTokens
  typeWeights?: Record<string, number>;
  now?: number;                   // injectable clock for tests
}
export interface PackMemory { id: string; type: string; text: string; score: number }
export function selectPack(db: DB, opts: PackOptions): PackMemory[];
export function renderPack(memories: PackMemory[]): string;   // grouped Markdown
export function estimateTokens(text: string): number;         // ceil(chars / 4)
```

- [ ] **Step 1: Write the failing test**

Create `tests/recall/pack.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { selectPack, renderPack, estimateTokens } from '../../src/recall/pack.js';

const DAY = 24 * 60 * 60 * 1000;

function seed(db: DB, type: string, text: string, importance: number, repo = 'r1') {
  new MemoryRepo(db).insert({
    type: type as never, text, normalized_text: text.toLowerCase(),
    repo, project: null, branch: null, agent: null, session_id: null,
    hash: `h-${type}-${text.slice(0, 24)}`, source_hash: null, importance,
  });
}

describe('selectPack (KF-B)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('filters by repo and ranks decisions above commands at equal importance', () => {
    seed(db, 'decision', 'Use SQLite not Postgres', 0.8);
    seed(db, 'command', 'npm test -- --reporter=verbose', 0.8);
    seed(db, 'decision', 'other repo decision', 0.9, 'other-repo');

    const pack = selectPack(db, { repo: 'r1', now: Date.now() });
    expect(pack).toHaveLength(2);
    expect(pack[0]?.type).toBe('decision');   // type weight 1.0 beats command 0.6
    expect(pack.every(m => m.text !== 'other repo decision')).toBe(true);
  });

  it('respects the token budget (keeps best, drops overflow)', () => {
    for (let i = 0; i < 50; i++) {
      seed(db, 'fact', `fact number ${i} — ${'x'.repeat(200)}`, 0.5);
    }
    const pack = selectPack(db, { repo: 'r1', budgetTokens: 200, now: Date.now() });
    const total = pack.reduce((sum, m) => sum + estimateTokens(m.text), 0);
    expect(total).toBeLessThanOrEqual(200);
    expect(pack.length).toBeGreaterThan(0);
  });

  it('budget smaller than any single memory → single best memory still returned', () => {
    seed(db, 'decision', 'a decision text well over the tiny budget '.repeat(4), 0.9);
    const pack = selectPack(db, { repo: 'r1', budgetTokens: 5, now: Date.now() });
    expect(pack).toHaveLength(1);
  });

  it('empty repo → empty pack, renderPack → empty string', () => {
    const pack = selectPack(db, { repo: 'empty-repo', now: Date.now() });
    expect(pack).toEqual([]);
    expect(renderPack(pack)).toBe('');
  });

  it('renderPack groups by type with memory ids', () => {
    seed(db, 'decision', 'Use SQLite', 0.9);
    seed(db, 'lesson', 'Bun lacks better-sqlite3 on Windows', 0.8);
    const md = renderPack(selectPack(db, { repo: 'r1', now: Date.now() }));
    expect(md).toContain('## Decisions');
    expect(md).toContain('## Lessons');
    expect(md).toContain('Use SQLite');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/recall/pack.test.ts`
Expected: FAIL — module `src/recall/pack.js` not found.

- [ ] **Step 3: Implement the selection module**

Create `src/recall/pack.ts`:

```typescript
/**
 * Memory-pack selection (KF-B) — the "injection judgment" v1.
 * Heuristic, no ML: score = typeWeight · recency · importance,
 * take top-N under a token budget, render grouped Markdown.
 * Recency half-life 30 days mirrors search freshness decay.
 */

import type { DB } from '../storage/db.js';

export interface PackOptions {
  repo: string;
  project?: string | null;
  branch?: string | null;
  budgetTokens?: number;
  typeWeights?: Record<string, number>;
  now?: number;
}

export interface PackMemory {
  id: string;
  type: string;
  text: string;
  score: number;
}

export const DEFAULT_TYPE_WEIGHTS: Record<string, number> = {
  decision: 1.0,
  lesson: 0.9,
  fact: 0.7,
  command: 0.6,
  note: 0.4,
  todo: 0.4,
  event: 0.4,
};

export const DEFAULT_BUDGET_TOKENS = 1500;
const RECENCY_HALF_LIFE_DAYS = 30;
const CANDIDATE_LIMIT = 500;

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface Row { id: string; type: string; text: string; importance: number; created_at: number }

export function selectPack(db: DB, opts: PackOptions): PackMemory[] {
  const now = opts.now ?? Date.now();
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const weights = opts.typeWeights ?? DEFAULT_TYPE_WEIGHTS;

  const rows = db.prepare(`
    SELECT id, type, text, importance, created_at
    FROM memories
    WHERE repo = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(opts.repo, CANDIDATE_LIMIT) as Row[];

  const scored: PackMemory[] = rows.map(r => {
    const ageDays = (now - r.created_at) / (24 * 60 * 60 * 1000);
    const recency = Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
    const typeWeight = weights[r.type] ?? 0.4;
    return { id: r.id, type: r.type, text: r.text, score: typeWeight * recency * r.importance };
  });

  scored.sort((a, b) => b.score - a.score);

  const pack: PackMemory[] = [];
  let spent = 0;
  for (const m of scored) {
    const cost = estimateTokens(m.text);
    if (spent + cost > budget) {
      // Guarantee at least the single best memory even under a tiny budget
      if (pack.length === 0) pack.push(m);
      break;
    }
    pack.push(m);
    spent += cost;
  }
  return pack;
}

const TYPE_HEADINGS: Record<string, string> = {
  decision: 'Decisions',
  lesson: 'Lessons',
  fact: 'Facts',
  command: 'Commands',
  todo: 'Todos',
  note: 'Notes',
  event: 'Events',
};

/** Render the pack as compact Markdown grouped by type, memory ids inline. */
export function renderPack(memories: PackMemory[]): string {
  if (memories.length === 0) return '';
  const byType = new Map<string, PackMemory[]>();
  for (const m of memories) {
    const list = byType.get(m.type) ?? [];
    list.push(m);
    byType.set(m.type, list);
  }
  const sections: string[] = ['# Repo memory pack'];
  for (const [type, list] of byType) {
    sections.push(`\n## ${TYPE_HEADINGS[type] ?? type}`);
    for (const m of list) sections.push(`- ${m.text} \`(${m.id})\``);
  }
  return sections.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/recall/pack.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add config + endpoint**

In `src/config/config.ts` add to the `Config` interface:

```typescript
  recallPack: { enabled: boolean; budgetTokens: number };
```

and to `defaultConfig()`:

```typescript
    recallPack: { enabled: false, budgetTokens: 1500 },
```

Create `src/server/routes/recall.ts`:

```typescript
/**
 * Memory-pack endpoint (KF-B):
 *   POST /recall/pack { repo, project?, branch?, budget_tokens? }
 * Returns { pack: <markdown>, memories: [...] }. Empty pack on zero matches (200).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../storage/db.js';
import { selectPack, renderPack } from '../../recall/pack.js';
import { defaultConfig } from '../../config/config.js';

const PackRequestSchema = z.object({
  repo: z.string().min(1),
  project: z.string().nullish(),
  branch: z.string().nullish(),
  budget_tokens: z.number().int().positive().max(8000).optional(),
});

export function recallRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.post('/recall/pack', async (req, reply) => {
      const parsed = PackRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const cfg = defaultConfig();
      const memories = selectPack(db, {
        repo: parsed.data.repo,
        project: parsed.data.project,
        branch: parsed.data.branch,
        budgetTokens: parsed.data.budget_tokens ?? cfg.recallPack.budgetTokens,
      });
      return { pack: renderPack(memories), memories };
    });
  };
}
```

In `src/server/app.ts` add:

```typescript
import { recallRoute } from './routes/recall.js';
```

```typescript
  await app.register(recallRoute(opts.db));
```

Add a route test to `tests/recall/pack.test.ts`:

```typescript
import { buildApp } from '../../src/server/app.js';

describe('POST /recall/pack (KF-B endpoint)', () => {
  it('returns markdown pack + memory list; empty repo → 200 with empty pack', async () => {
    const db = openDb(':memory:');
    migrate(db);
    seed(db, 'decision', 'Use SQLite', 0.9);
    const app = await buildApp({ db, token: 't' });

    const hit = await app.inject({
      method: 'POST', url: '/recall/pack',
      headers: { authorization: 'Bearer t' },
      payload: { repo: 'r1' },
    });
    expect(hit.statusCode).toBe(200);
    expect(hit.json().pack).toContain('Use SQLite');

    const miss = await app.inject({
      method: 'POST', url: '/recall/pack',
      headers: { authorization: 'Bearer t' },
      payload: { repo: 'no-such-repo' },
    });
    expect(miss.statusCode).toBe(200);
    expect(miss.json()).toEqual({ pack: '', memories: [] });
  });

  it('bad body → 400', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const app = await buildApp({ db, token: 't' });
    const res = await app.inject({
      method: 'POST', url: '/recall/pack',
      headers: { authorization: 'Bearer t' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 7: Write the hook install doc**

Create `docs/hooks/memory-pack.md`:

~~~markdown
# Claude Code hook — proactive memory pack

Injects the repo's memory pack at session start. The daemon decides what the
agent should already know: decisions, lessons, facts — token-budgeted.

Degrades silently: daemon down → empty output, session never blocked.

## Install (manual, v1)

Add to `.claude/settings.json` (project) or `~/.claude/settings.json` (global):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -m 2 -X POST http://127.0.0.1:7777/recall/pack -H \"Authorization: Bearer $ASTRAMEM_TOKEN\" -H \"Content-Type: application/json\" -d \"{\\\"repo\\\": \\\"$(basename \\\"$PWD\\\")\\\"}\" | node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const p=JSON.parse(d).pack;if(p)console.log(p)}catch{}})\"",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

Notes:
- `ASTRAMEM_TOKEN` — the daemon bearer token from `astramem-local init`.
- 2s curl cap + 3s hook timeout: the hard latency ceiling. Failure = silence.
- Windows: replace the command with the PowerShell equivalent:
  `powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7777/recall/pack -Headers @{Authorization=\"Bearer $env:ASTRAMEM_TOKEN\"} -ContentType application/json -Body (@{repo=(Split-Path -Leaf (Get-Location))} | ConvertTo-Json) -TimeoutSec 2; if ($r.pack) { $r.pack } } catch {}"`

## Roadmap

Auto-install via `astramem-local init` lands with the launch wave (the
`recallPack.enabled` config flag gates the wizard offer).
~~~

- [ ] **Step 8: Commit**

```bash
git add src/recall/pack.ts src/server/routes/recall.ts src/server/app.ts src/config/config.ts docs/hooks/memory-pack.md tests/recall/pack.test.ts
git commit -m "feat(recall): memory-pack selection + POST /recall/pack + hook install doc (KF-B)"
```
