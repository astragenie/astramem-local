/**
 * CLI commands: search, recall, remember
 *
 * These commands talk to a running daemon via HTTP.
 * Base URL: ASTRA_MEMORY_URL env (default http://127.0.0.1:7777)
 * Token:    ASTRA_MEMORY_TOKEN env (default 'devtok')
 */

import { MEMORY_TYPES } from '../contracts/memory.js';

function getBaseUrl(): string {
  return process.env.ASTRA_MEMORY_URL ?? 'http://127.0.0.1:7777';
}

function getToken(): string {
  return process.env.ASTRA_MEMORY_TOKEN ?? 'devtok';
}

function authHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'authorization': `Bearer ${getToken()}`
  };
}

/**
 * FEAT-423: split a comma-separated CLI value into the filter shape POST
 * /recall expects — one value stays a string, many become a string[] (IN).
 * GET /search does this server-side, so this is only needed on the POST path.
 */
function csvFilter(raw: string): string | string[] {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  return parts.length <= 1 ? (parts[0] ?? raw) : parts;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { ...authHeaders(), ...(init?.headers as Record<string, string> ?? {}) } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export interface SearchCliOpts {
  type?: string;
  repo?: string;
  since?: string;
  limit?: string;
  /** FEAT-401: ISO-8601 date-time. Forwarded verbatim to the API's `as_of`
   *  query param — the CLI does no local filtering, so this is the same
   *  code path as the API (GET /search -> search() -> validityFilterClause). */
  asOf?: string;
  /** FEAT-402 slice 2 AC-4: entity name, forwarded verbatim to `entity=`. */
  entity?: string;
  /** FEAT-423: project name, forwarded verbatim to `project=`. The daemon
   *  filters atoms on `provenance.project`; absent → unfiltered (all projects). */
  project?: string;
  /** FEAT-423: agent name, forwarded verbatim to `agent=` — exact match on
   *  provenance agent/agent_type; absent → all agents. */
  agent?: string;
}

export async function cliSearch(query: string, opts: SearchCliOpts): Promise<void> {
  const params = new URLSearchParams({ q: query });
  if (opts.type) params.set('type', opts.type);
  if (opts.repo) params.set('repo', opts.repo);
  if (opts.since) params.set('since', opts.since);
  if (opts.limit) params.set('limit', opts.limit);
  if (opts.asOf) params.set('as_of', opts.asOf);
  if (opts.entity) params.set('entity', opts.entity);
  if (opts.project) params.set('project', opts.project);
  if (opts.agent) params.set('agent', opts.agent);

  const base = getBaseUrl();
  const result = await fetchJson(`${base}/search?${params.toString()}`) as { hits: unknown[] };

  if (!result.hits || result.hits.length === 0) {
    console.log('No results found.');
    return;
  }

  console.table(
    result.hits.map((h: unknown) => {
      const hit = h as { id: string; type: string; text: string; score: number; source: string };
      return {
        id: hit.id.slice(0, 8) + '...',
        type: hit.type,
        source: hit.source,
        score: hit.score.toFixed(3),
        text: hit.text.length > 60 ? hit.text.slice(0, 57) + '...' : hit.text
      };
    })
  );
}

export interface RecallCliOpts {
  k?: string;
  type?: string;
  repo?: string;
  /** FEAT-401: ISO-8601 date-time, forwarded to POST /recall filters.as_of. */
  asOf?: string;
  /** FEAT-402 slice 2 AC-4: entity name, forwarded to POST /recall filters.entity. */
  entity?: string;
  /** FEAT-423: project name, forwarded to POST /recall filters.project.
   *  Absent → unfiltered recall across all projects. */
  project?: string;
  /** FEAT-423: agent name, forwarded to POST /recall filters.agent. */
  agent?: string;
}

export async function cliRecall(question: string, opts: RecallCliOpts): Promise<void> {
  const k = opts.k ? Number(opts.k) : 5;
  const filters: Record<string, unknown> = {};
  if (opts.type) filters.type = [opts.type];
  if (opts.repo) filters.repo = opts.repo;
  if (opts.asOf) filters.as_of = opts.asOf;
  if (opts.entity) filters.entity = opts.entity;
  if (opts.project) filters.project = csvFilter(opts.project);
  if (opts.agent) filters.agent = csvFilter(opts.agent);

  const base = getBaseUrl();
  const result = await fetchJson(`${base}/recall`, {
    method: 'POST',
    body: JSON.stringify({ query: question, k, filters: Object.keys(filters).length ? filters : undefined })
  }) as { hits: unknown[] };

  if (!result.hits || result.hits.length === 0) {
    console.log('No relevant memories found.');
    return;
  }

  console.table(
    result.hits.map((h: unknown) => {
      const hit = h as { id: string; type: string; text: string; score: number; source: string };
      return {
        id: hit.id.slice(0, 8) + '...',
        type: hit.type,
        source: hit.source,
        score: hit.score.toFixed(3),
        text: hit.text.length > 60 ? hit.text.slice(0, 57) + '...' : hit.text
      };
    })
  );
}

export interface RememberCliOpts {
  type?: string;
  repo?: string;
  /** FEAT-423: persist provenance.project so the atom is later recallable
   *  under `recall --project`. Written into metadata.project (route:
   *  RememberBodySchema.metadata.project → memories.project column). */
  project?: string;
  /** FEAT-423: persist provenance.agent so the atom is later recallable
   *  under `recall --agent`. Written into metadata.agent → memories.agent. */
  agent?: string;
}

export async function cliRemember(text: string, opts: RememberCliOpts): Promise<void> {
  const type = opts.type ?? 'fact';
  // Authoritative list from the contract — a hand-copied array here once
  // drifted to 5 types and silently rejected note/event.
  if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
    console.error(`Invalid type "${type}". Valid types: ${MEMORY_TYPES.join(', ')}`);
    process.exit(1);
  }

  const metadata: Record<string, string> = {};
  if (opts.repo) metadata.repo = opts.repo;
  if (opts.project) metadata.project = opts.project;
  if (opts.agent) metadata.agent = opts.agent;

  const base = getBaseUrl();
  const result = await fetchJson(`${base}/remember`, {
    method: 'POST',
    body: JSON.stringify({
      text,
      type,
      metadata: Object.keys(metadata).length ? metadata : undefined
    })
  }) as { id: string; ok: boolean };

  console.log(`Remembered: ${result.id}`);
}

/**
 * `astramem-local entities list [query] [--limit N]` (FEAT-402 slice 2 AC-5)
 * — thin HTTP client of GET /entities?q=, same pattern as cliSearch/cliRecall.
 */
export interface EntitiesListCliOpts {
  limit?: string;
}

export async function cliEntitiesList(query: string, opts: EntitiesListCliOpts): Promise<void> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (opts.limit) params.set('limit', opts.limit);

  const base = getBaseUrl();
  const qs = params.toString();
  const result = await fetchJson(`${base}/entities${qs ? `?${qs}` : ''}`) as {
    entities: Array<{ id: string; name: string; kind: string }>;
  };

  if (!result.entities || result.entities.length === 0) {
    console.log('No entities found.');
    return;
  }

  console.table(
    result.entities.map(e => ({ id: e.id.slice(0, 8) + '...', name: e.name, kind: e.kind }))
  );
}

/**
 * `astramem-local entities show <id>` (FEAT-402 slice 2 AC-5) — thin HTTP
 * client of GET /entities/:id/memories.
 */
export async function cliEntitiesShow(id: string): Promise<void> {
  if (!id) {
    console.error('entities show: id argument is required');
    process.exit(1);
  }

  const base = getBaseUrl();
  const result = await fetchJson(`${base}/entities/${encodeURIComponent(id)}/memories`) as {
    entity: { id: string; name: string; kind: string };
    memories: Array<{ id: string; type: string; text: string }>;
  };

  console.log('');
  console.log(`  Entity: ${result.entity.name} (${result.entity.kind})`);
  console.log(`  ${result.entity.id}`);
  console.log('');

  if (!result.memories || result.memories.length === 0) {
    console.log('No memories linked to this entity.');
    return;
  }

  console.table(
    result.memories.map(m => ({
      id: m.id.slice(0, 8) + '...',
      type: m.type,
      text: m.text.length > 60 ? m.text.slice(0, 57) + '...' : m.text
    }))
  );
}
