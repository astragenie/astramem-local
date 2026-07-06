/**
 * SLICE-SMOKE-1 — Daemon E2E smoke suite.
 *
 * Proves the flagship "local-first memory daemon" promise end to end against
 * a REAL spawned daemon + REAL file-based SQLite datadir (not `:memory:`,
 * unlike tests/e2e/plugin-flow.test.ts and tests/integration/ingest-e2e.test.ts):
 * spawn -> ingest -> distill drain -> HTTP query battery -> CLI argv battery
 * -> SIGKILL -> respawn against the SAME datadir -> identical results ->
 * teardown with zero residue. See .claude/artifacts/crew/runs/2026-07-04-smoke-suite-phase0-1.md
 * for the full gap analysis + locked acceptance criteria this suite satisfies.
 *
 * F1 (architect, BLOCKING, resolved): a spawned daemon against a file datadir
 * would otherwise hit the REAL %APPDATA%\Astramem / %LOCALAPPDATA%\Astramem
 * and the real OS Credential Manager (security.encryption.enabled defaults
 * true -> getOrCreateKey() -> @napi-rs/keyring). Fixed by spawning with
 * APPDATA/LOCALAPPDATA/HOME/XDG_CONFIG_HOME/XDG_DATA_HOME redirected into a
 * temp sandbox (see tests/smoke/helpers/daemon.ts:makeIsolatedDaemonEnv) plus
 * a config.yaml with encryption disabled — see step 0 and the final
 * real-APPDATA-untouched assertion in step 6.
 *
 * DEVIATION (orchestrator-approved, 2026-07-04): the fixture below seeds a
 * person (Priya Nair), a repo (astramemory-local), a technology
 * (TypeScript), a todo, and a preference-shaped note, in addition to the
 * sqlite-vec decision. Producing entities/type-diversity from a mocked
 * daemon required extending src/pipeline/mock-providers.ts's MockLLMProvider
 * with a small deterministic keyword->atom/entity table (see that file's
 * header) — a relaxation of "no product-code changes" for test-double code
 * only, approved by the orchestrator after the mock's original hardcoded
 * behavior (single sqlite-vec decision atom, no entities) turned out to make
 * a fixture-derived entity/type battery impossible. The extension is
 * strictly additive and gated behind ASTRA_MEMORY_MOCK_PROVIDERS=1 (never
 * reachable in real serving); tests/e2e/plugin-flow.test.ts — which never
 * mentions the new trigger keywords — stays green with zero assertion
 * changes as the non-regression proof.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readLockInfo } from '../../src/service/instance-lock.js';
import { defaultConfigDir, defaultDataDir } from '../../src/config/datadir.js';
import {
  spawnDaemon, killDaemon, waitForHealthOk, pollSearchHits,
  makeIsolatedDaemonEnv, cleanupIsolatedDaemonEnv, REPO_ROOT,
  type DaemonHandle, type IsolatedDaemonEnv, type SearchHit,
} from './helpers/daemon.js';

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = 19000;
const TOKEN = 'smoke-tok-1';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } as const;

const FIXTURE_PATH = join(
  new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  '_fixtures',
  'session-canonical.json',
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  captured_at: string;
  project_id: string;
  agent_type: string;
};

// Real (unmodified) OS dirs, resolved in THIS process (never touched by the
// spawned daemon, which gets APPDATA/LOCALAPPDATA overridden — see below).
const REAL_CONFIG_DIR = defaultConfigDir();
const REAL_DATA_DIR = defaultDataDir();

/**
 * Sorted filename listing of a directory's immediate children (null if
 * absent). Deliberately name-set only, not mtimes/content: on a dev machine
 * that also runs a REAL astramem-local service (schtasks keepalive) against
 * this same real data dir, that live daemon legitimately rewrites
 * memory.sqlite-wal/daemon.lock on its own schedule — comparing mtimes would
 * make this assertion flaky against ambient background activity unrelated to
 * this test. What actually matters for "never touched" is that our
 * sandboxed spawn created or deleted nothing here — a file-set diff proves
 * exactly that without false positives from a concurrently-running real
 * daemon.
 */
function snapshotDir(dir: string): string[] | null {
  if (!existsSync(dir)) return null;
  return [...readdirSync(dir)].sort();
}

const realDirsBefore = { config: snapshotDir(REAL_CONFIG_DIR), data: snapshotDir(REAL_DATA_DIR) };

// ── CLI battery helper ───────────────────────────────────────────────────────

interface CliResult { status: number | null; stdout: string; stderr: string }

function runCli(args: string[]): CliResult {
  try {
    const stdout = execFileSync(process.execPath, ['dist/cli/index.js', ...args], {
      cwd: REPO_ROOT,
      env: {
        ...(process.env as Record<string, string>),
        ASTRA_MEMORY_URL: BASE_URL,
        ASTRA_MEMORY_TOKEN: TOKEN,
      },
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { status: e.status ?? null, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

// ── Suite state (shared across the sequential steps) ────────────────────────

let isolated: IsolatedDaemonEnv;
let daemon: DaemonHandle | null = null;
let firstMemoryId: string;

describe.sequential('Daemon E2E smoke suite (SLICE-SMOKE-1)', () => {
  beforeAll(() => {
    isolated = makeIsolatedDaemonEnv('astramem-smoke');
  });

  afterAll(async () => {
    // Defensive backstop: holds even if a step above threw before its own
    // cleanup ran (AC-6 "must hold on failure paths too").
    if (daemon) await killDaemon(daemon, 'SIGKILL', 5_000);
    cleanupIsolatedDaemonEnv(isolated);
  });

  it('step 0: isolated config+data sandbox created — encryption disabled, never aliases real OS dirs', () => {
    expect(existsSync(isolated.configDir)).toBe(true);
    expect(existsSync(isolated.dataDir)).toBe(true);
    const cfgText = readFileSync(join(isolated.configDir, 'config.yaml'), 'utf8');
    expect(cfgText).toContain('enabled: false');

    // The sandboxed dirs must never coincide with the real ones this process
    // itself resolves to (would defeat the whole point of the sandbox).
    expect(isolated.configDir).not.toBe(REAL_CONFIG_DIR);
    expect(isolated.dataDir).not.toBe(REAL_DATA_DIR);
  });

  it('step 1: daemon spawns and GET /health reports status "ok" (AC-1)', async () => {
    daemon = spawnDaemon({ port: PORT, token: TOKEN, env: isolated.env });
    daemon.proc.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[smoke-daemon] ${chunk.toString()}`);
    });

    await waitForHealthOk(BASE_URL);
    expect(daemon.exitInfo().code, `daemon exited early — stderr:\n${daemon.stderr()}`).toBeNull();
  }, 20_000);

  it('step 2: canonical ingest returns 200 and distill drains to searchable memories (AC-2)', async () => {
    const res = await fetch(`${BASE_URL}/ingest/transcript`, {
      method: 'POST',
      headers: { ...AUTH, 'idempotency-key': 'smoke-ingest-1' },
      body: JSON.stringify(FIXTURE),
    });
    const body = (await res.json()) as { ok: boolean; summary_memory_id: string; session_id: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.session_id).toBe('smoke-session-canonical-1');

    const hits = await pollSearchHits(
      BASE_URL,
      TOKEN,
      'sqlite',
      allHits => allHits.filter(h => h.type === 'decision' && h.text.toLowerCase().includes('sqlite-vec')),
      { label: 'distill worker to drain the transcript into a decision memory mentioning sqlite-vec' },
    );
    expect(hits.length).toBeGreaterThan(0);
    firstMemoryId = hits[0]!.id;
  }, 40_000);

  it('step 3: HTTP query battery — all Bearer-authed, fixture-derived where the mock supports it (AC-3)', async () => {
    // GET /search hybrid q
    const search = await fetch(`${BASE_URL}/search?q=sqlite&limit=20`, { headers: AUTH });
    expect(search.status).toBe(200);
    const searchBody = (await search.json()) as { hits: SearchHit[] };
    expect(searchBody.hits.some(h => h.id === firstMemoryId)).toBe(true);

    // &type=
    const byType = await fetch(`${BASE_URL}/search?q=sqlite&type=decision&limit=20`, { headers: AUTH });
    expect(byType.status).toBe(200);
    expect(((await byType.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(true);

    // &entity= — fixture-derived: the "Priya Nair" fact atom carries a
    // linked person entity (the sqlite-vec decision atom itself carries
    // none, kept byte-identical to the original mock — see mock-providers.ts).
    const priyaSearch = await fetch(`${BASE_URL}/search?q=reviewer&entity=${encodeURIComponent('Priya Nair')}&limit=20`, { headers: AUTH });
    expect(priyaSearch.status).toBe(200);
    const priyaHits = ((await priyaSearch.json()) as { hits: SearchHit[] }).hits;
    expect(priyaHits.some(h => h.type === 'fact' && h.text.includes('Priya Nair'))).toBe(true);

    // GET /entities?q= — fixture-derived: all three seeded entities resolve.
    // Entity names are stored normalized (src/entity/normalize.ts: lowercase
    // + trim + whitespace-collapse) — the memory TEXT keeps its authored
    // case, but entities.name does not.
    const entitiesQ = await fetch(`${BASE_URL}/entities?q=Priya`, { headers: AUTH });
    expect(entitiesQ.status).toBe(200);
    const priyaEntities = ((await entitiesQ.json()) as { entities: Array<{ id: string; name: string; kind: string }> }).entities;
    const priyaEntity = priyaEntities.find(e => e.name === 'priya nair' && e.kind === 'person');
    expect(priyaEntity).toBeDefined();

    const repoEntitiesRes = await fetch(`${BASE_URL}/entities?q=astramemory`, { headers: AUTH });
    const repoEntities = ((await repoEntitiesRes.json()) as { entities: Array<{ id: string; name: string; kind: string }> }).entities;
    expect(repoEntities.some(e => e.name === 'astramemory-local' && e.kind === 'repo')).toBe(true);

    const techEntitiesRes = await fetch(`${BASE_URL}/entities?q=TypeScript`, { headers: AUTH });
    const techEntities = ((await techEntitiesRes.json()) as { entities: Array<{ id: string; name: string; kind: string }> }).entities;
    expect(techEntities.some(e => e.name === 'typescript' && e.kind === 'tech')).toBe(true);

    // GET /entities/:id/memories — fixture-derived: Priya Nair's linked
    // memory list must contain the fact atom that named her.
    const priyaMemoriesRes = await fetch(`${BASE_URL}/entities/${priyaEntity!.id}/memories`, { headers: AUTH });
    expect(priyaMemoriesRes.status).toBe(200);
    const priyaMemoriesBody = (await priyaMemoriesRes.json()) as {
      entity: { id: string; name: string; kind: string };
      memories: Array<{ id: string; type: string; text: string }>;
    };
    expect(priyaMemoriesBody.entity.name).toBe('priya nair');
    expect(priyaMemoriesBody.memories.some(m => m.type === 'fact' && m.text.includes('Priya Nair'))).toBe(true);

    // &type= diversity — fixture-derived: todo and note (preference-shaped)
    // atoms distinct from the decision/fact atoms above.
    const todoSearch = await fetch(`${BASE_URL}/search?q=migration&type=todo&limit=20`, { headers: AUTH });
    expect(todoSearch.status).toBe(200);
    expect(((await todoSearch.json()) as { hits: SearchHit[] }).hits.some(h => h.type === 'todo')).toBe(true);

    const noteSearch = await fetch(`${BASE_URL}/search?q=markdown&type=note&limit=20`, { headers: AUTH });
    expect(noteSearch.status).toBe(200);
    expect(((await noteSearch.json()) as { hits: SearchHit[] }).hits.some(h => h.type === 'note')).toBe(true);

    // &as_of= in the future (after the real memory's valid_from) -> included
    const futureAsOf = new Date(Date.now() + 60_000).toISOString();
    const asOfFuture = await fetch(`${BASE_URL}/search?q=sqlite&as_of=${encodeURIComponent(futureAsOf)}&limit=20`, { headers: AUTH });
    expect(asOfFuture.status).toBe(200);
    expect(((await asOfFuture.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(true);

    // &as_of= at the fixture's (fake, far past) captured_at -> excluded —
    // the real memory's valid_from is wall-clock "now" (test run time).
    const pastAsOf = await fetch(`${BASE_URL}/search?q=sqlite&as_of=${encodeURIComponent(FIXTURE.captured_at)}&limit=20`, { headers: AUTH });
    expect(pastAsOf.status).toBe(200);
    expect(((await pastAsOf.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(false);

    // &since= recent past -> included; &since= future -> excluded
    const sinceRecent = await fetch(`${BASE_URL}/search?q=sqlite&since=${Date.now() - 60_000}&limit=20`, { headers: AUTH });
    expect(((await sinceRecent.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(true);
    const sinceFuture = await fetch(`${BASE_URL}/search?q=sqlite&since=${Date.now() + 60_000}&limit=20`, { headers: AUTH });
    expect(((await sinceFuture.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(false);

    // &repo= — canonical envelopes never populate the `repo` session column
    // (see ingest.ts:117 comment — only cwd/project_id are carried), so this
    // is a wiring proof (200 + empty), not a fixture-derived match.
    const byRepo = await fetch(`${BASE_URL}/search?q=sqlite&repo=astramemory-local&limit=20`, { headers: AUTH });
    expect(byRepo.status).toBe(200);

    // &project= — DOES resolve for canonical envelopes (project_id -> sessions.project).
    const byProject = await fetch(`${BASE_URL}/search?q=sqlite&project=${encodeURIComponent(FIXTURE.project_id)}&limit=20`, { headers: AUTH });
    expect(byProject.status).toBe(200);
    expect(((await byProject.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(true);

    // &project= WRONG value -> excluded (FEAT-423: proves the filter is not a
    // no-op — the original issue #56 symptom was every value returning all).
    const byWrongProject = await fetch(`${BASE_URL}/search?q=sqlite&project=nonexistent-project&limit=20`, { headers: AUTH });
    expect(byWrongProject.status).toBe(200);
    expect(((await byWrongProject.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(false);

    // &project=a,b multi-value (FEAT-423) -> IN (...) OR-semantics: the real
    // project listed alongside a decoy still matches.
    const byProjectList = await fetch(`${BASE_URL}/search?q=sqlite&project=${encodeURIComponent(FIXTURE.project_id)},decoy-project&limit=20`, { headers: AUTH });
    expect(byProjectList.status).toBe(200);
    expect(((await byProjectList.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(true);

    // &agent= — canonical agent_type -> sessions.agent -> atom.agent (FEAT-423).
    const byAgent = await fetch(`${BASE_URL}/search?q=sqlite&agent=${encodeURIComponent(FIXTURE.agent_type)}&limit=20`, { headers: AUTH });
    expect(byAgent.status).toBe(200);
    expect(((await byAgent.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(true);

    // &agent= WRONG value -> excluded (hard-filter proof).
    const byWrongAgent = await fetch(`${BASE_URL}/search?q=sqlite&agent=nonexistent-agent&limit=20`, { headers: AUTH });
    expect(byWrongAgent.status).toBe(200);
    expect(((await byWrongAgent.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(false);

    // POST /recall
    const recall = await fetch(`${BASE_URL}/recall`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ query: 'sqlite', k: 5 }),
    });
    expect(recall.status).toBe(200);
    expect(((await recall.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(true);

    // POST /recall with filters.project + filters.agent (FEAT-423) — the exact
    // shape the astramem-plugin LocalProvider now sends. Correct pair -> hit.
    const recallScoped = await fetch(`${BASE_URL}/recall`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ query: 'sqlite', k: 5, filters: { project: FIXTURE.project_id, agent: FIXTURE.agent_type } }),
    });
    expect(recallScoped.status).toBe(200);
    expect(((await recallScoped.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(true);

    // POST /recall with a WRONG filters.project -> excluded (no-op guard).
    const recallWrong = await fetch(`${BASE_URL}/recall`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ query: 'sqlite', k: 5, filters: { project: 'nonexistent-project' } }),
    });
    expect(recallWrong.status).toBe(200);
    expect(((await recallWrong.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(false);

    // POST /recall with a multi-value filters.agent array (FEAT-423) -> IN.
    const recallAgentList = await fetch(`${BASE_URL}/recall`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ query: 'sqlite', k: 5, filters: { agent: [FIXTURE.agent_type, 'decoy-agent'] } }),
    });
    expect(recallAgentList.status).toBe(200);
    expect(((await recallAgentList.json()) as { hits: SearchHit[] }).hits.some(h => h.id === firstMemoryId)).toBe(true);

    // POST /memory-tool { command: 'view', path: '/memories/decision.md' } — route smoke,
    // fixture-derived: the rendered markdown must name our memory id + text.
    const memoryTool = await fetch(`${BASE_URL}/memory-tool`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ command: 'view', path: '/memories/decision.md' }),
    });
    expect(memoryTool.status).toBe(200);
    const memoryToolBody = (await memoryTool.json()) as { content?: string; error?: string };
    expect(memoryToolBody.error).toBeUndefined();
    expect(memoryToolBody.content).toContain(firstMemoryId);
    expect(memoryToolBody.content?.toLowerCase()).toContain('sqlite-vec');

    // Same route, a second type — proves the adapter isn't decision-only.
    const memoryToolTodo = await fetch(`${BASE_URL}/memory-tool`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ command: 'view', path: '/memories/todo.md' }),
    });
    expect(memoryToolTodo.status).toBe(200);
    const memoryToolTodoBody = (await memoryToolTodo.json()) as { content?: string; error?: string };
    expect(memoryToolTodoBody.error).toBeUndefined();
    expect(memoryToolTodoBody.content?.toLowerCase()).toContain('migration guide');
  }, 20_000);

  it('step 4: CLI real-argv battery — exit 0 + expected id/text in stdout, thin wiring only (AC-4)', () => {
    const idPrefix = firstMemoryId.slice(0, 8);

    const search = runCli(['search', 'sqlite']);
    expect(search.status, search.stderr).toBe(0);
    expect(search.stdout).toContain(idPrefix);

    const recall = runCli(['recall', 'sqlite']);
    expect(recall.status, recall.stderr).toBe(0);
    expect(recall.stdout).toContain(idPrefix);

    const asOf = runCli(['search', 'sqlite', '--as-of', new Date(Date.now() + 60_000).toISOString()]);
    expect(asOf.status, asOf.stderr).toBe(0);
    expect(asOf.stdout).toContain(idPrefix);

    // --entity fixture-derived: "Priya Nair" is linked to the fact atom
    // naming her as reviewer.
    const byEntity = runCli(['recall', 'reviewer', '--entity', 'Priya Nair']);
    expect(byEntity.status, byEntity.stderr).toBe(0);
    expect(byEntity.stdout).toContain('Priya Nair');

    // --project / --agent fixture-derived (FEAT-423): the canonical envelope's
    // project_id + agent_type flow onto every distilled atom.
    const byProjectCli = runCli(['recall', 'sqlite', '--project', FIXTURE.project_id]);
    expect(byProjectCli.status, byProjectCli.stderr).toBe(0);
    expect(byProjectCli.stdout).toContain(idPrefix);

    const byAgentCli = runCli(['recall', 'sqlite', '--agent', FIXTURE.agent_type]);
    expect(byAgentCli.status, byAgentCli.stderr).toBe(0);
    expect(byAgentCli.stdout).toContain(idPrefix);

    // Wrong project -> exit 0 but no hit (prints "No relevant memories found.").
    const byWrongProjectCli = runCli(['recall', 'sqlite', '--project', 'nonexistent-project']);
    expect(byWrongProjectCli.status, byWrongProjectCli.stderr).toBe(0);
    expect(byWrongProjectCli.stdout).not.toContain(idPrefix);

    const entitiesList = runCli(['entities', 'list', 'Priya']);
    expect(entitiesList.status, entitiesList.stderr).toBe(0);
    // entities.name is stored normalized (lowercase) — see the search-battery
    // comment above; the CLI table renders the stored value verbatim.
    expect(entitiesList.stdout).toContain('priya nair');
  }, 40_000); // 5 sequential child-process spawns — needs headroom under full-suite CPU contention

  it('step 5: SIGKILL + respawn against the SAME datadir — identical results, daemon.lock PID changed (AC-5, AC-9)', async () => {
    const priorLock = readLockInfo(isolated.dataDir);
    expect(priorLock).not.toBeNull();
    const priorPid = priorLock!.pid;
    expect(priorPid).toBe(daemon!.proc.pid);

    const before = await fetch(`${BASE_URL}/search?q=sqlite&limit=20`, { headers: AUTH });
    const beforeIds = ((await before.json()) as { hits: SearchHit[] }).hits.map(h => h.id).sort();
    expect(beforeIds).toContain(firstMemoryId);

    // No graceful shutdown — exercises stale-lock steal (instance-lock.ts
    // pidAlive() false path) + WAL recovery on the next boot, not the clean
    // SIGTERM path.
    await killDaemon(daemon, 'SIGKILL', 5_000);
    expect(daemon.exitInfo().signal, 'daemon should have been force-killed').toBe('SIGKILL');

    daemon = spawnDaemon({ port: PORT, token: TOKEN, env: isolated.env });
    daemon.proc.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[smoke-daemon-respawn] ${chunk.toString()}`);
    });
    await waitForHealthOk(BASE_URL);
    expect(daemon.exitInfo().code, `respawned daemon exited early — stderr:\n${daemon.stderr()}`).toBeNull();

    const after = await fetch(`${BASE_URL}/search?q=sqlite&limit=20`, { headers: AUTH });
    const afterIds = ((await after.json()) as { hits: SearchHit[] }).hits.map(h => h.id).sort();
    expect(afterIds).toEqual(beforeIds);

    const newLock = readLockInfo(isolated.dataDir);
    expect(newLock).not.toBeNull();
    expect(newLock!.pid).toBe(daemon.proc.pid);
    expect(newLock!.pid).not.toBe(priorPid);
  }, 30_000);

  it('step 6: teardown — kill daemon, remove temp dirs, verify port free, real OS dirs untouched (AC-6)', async () => {
    await killDaemon(daemon!, 'SIGTERM', 5_000);
    const exitInfo = daemon!.exitInfo();
    expect(exitInfo.code === 0 || exitInfo.signal !== null).toBe(true);
    daemon = null; // afterAll's backstop becomes a no-op

    // Port must be free — a fetch against it should fail to connect, not
    // find a lingering server.
    await expect(fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1_000) })).rejects.toBeTruthy();

    cleanupIsolatedDaemonEnv(isolated);
    expect(existsSync(isolated.root)).toBe(false);

    // Real %APPDATA%\Astramem / %LOCALAPPDATA%\Astramem (or their non-Windows
    // equivalents) must be byte-for-byte untouched — same file list, same
    // mtimes, as captured before step 0 ever ran (AC-9 extended: not just
    // the credential store, the legacy-dir migration logic too — see
    // makeIsolatedDaemonEnv's LOCALAPPDATA-override doc comment).
    const realDirsAfter = { config: snapshotDir(REAL_CONFIG_DIR), data: snapshotDir(REAL_DATA_DIR) };
    expect(realDirsAfter).toEqual(realDirsBefore);
  }, 15_000);
});
