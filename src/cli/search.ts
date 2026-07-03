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
}

export async function cliSearch(query: string, opts: SearchCliOpts): Promise<void> {
  const params = new URLSearchParams({ q: query });
  if (opts.type) params.set('type', opts.type);
  if (opts.repo) params.set('repo', opts.repo);
  if (opts.since) params.set('since', opts.since);
  if (opts.limit) params.set('limit', opts.limit);

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
}

export async function cliRecall(question: string, opts: RecallCliOpts): Promise<void> {
  const k = opts.k ? Number(opts.k) : 5;
  const filters: Record<string, unknown> = {};
  if (opts.type) filters.type = [opts.type];
  if (opts.repo) filters.repo = opts.repo;

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
