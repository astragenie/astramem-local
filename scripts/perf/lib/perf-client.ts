/** Thin HTTP client for the perf harness — fields verified against
 *  src/server/routes/{search,recall,agents,digest,why,memory,health}.ts. */

export interface PerfClientOpts {
  baseUrl: string;
  token: string;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

export interface RememberBody {
  text: string;
  type: string;
  metadata?: Record<string, unknown>;
}

export async function remember(c: PerfClientOpts, body: RememberBody): Promise<{ id: string; ok: boolean }> {
  const res = await fetch(`${c.baseUrl}/remember`, {
    method: 'POST',
    headers: authHeaders(c.token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST /remember failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json() as Promise<{ id: string; ok: boolean }>;
}

export async function search(c: PerfClientOpts, q: string, limit = 10): Promise<unknown> {
  const url = new URL(`${c.baseUrl}/search`);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url, { headers: authHeaders(c.token) });
  if (!res.ok) throw new Error(`GET /search failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

export async function recall(c: PerfClientOpts, text: string, limit = 5): Promise<unknown> {
  const res = await fetch(`${c.baseUrl}/recall`, {
    method: 'POST',
    headers: authHeaders(c.token),
    body: JSON.stringify({ text, limit }),
  });
  if (!res.ok) throw new Error(`POST /recall failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

export async function recallPack(c: PerfClientOpts, repo: string): Promise<unknown> {
  const res = await fetch(`${c.baseUrl}/recall/pack`, {
    method: 'POST',
    headers: authHeaders(c.token),
    body: JSON.stringify({ repo }),
  });
  if (!res.ok) throw new Error(`POST /recall/pack failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

export async function agentProfile(c: PerfClientOpts, agent: string): Promise<unknown> {
  const res = await fetch(`${c.baseUrl}/agents/${encodeURIComponent(agent)}/profile`, {
    headers: authHeaders(c.token),
  });
  if (!res.ok) throw new Error(`GET /agents/${agent}/profile failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

export async function sessionDigest(c: PerfClientOpts, sessionId: string): Promise<unknown> {
  const res = await fetch(`${c.baseUrl}/sessions/${encodeURIComponent(sessionId)}/digest`, {
    headers: authHeaders(c.token),
  });
  if (!res.ok) throw new Error(`GET /sessions/${sessionId}/digest failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

export async function memoryWhy(c: PerfClientOpts, id: string): Promise<unknown> {
  const res = await fetch(`${c.baseUrl}/memory/${encodeURIComponent(id)}/why`, {
    headers: authHeaders(c.token),
  });
  if (!res.ok) throw new Error(`GET /memory/${id}/why failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

export async function health(c: PerfClientOpts): Promise<unknown> {
  const res = await fetch(`${c.baseUrl}/health`, { headers: authHeaders(c.token) });
  if (!res.ok) throw new Error(`GET /health failed: HTTP ${res.status}`);
  return res.json();
}

export interface CanonicalTurn { role: 'user' | 'assistant'; text: string }

export async function ingestTranscript(
  c: PerfClientOpts,
  opts: { sessionId: string; projectId: string; agentType: string; turns: CanonicalTurn[] },
  idempotencyKey: string,
): Promise<{ status: number; body: { ok: boolean; session_id: string; extraction_job_id?: string } }> {
  const res = await fetch(`${c.baseUrl}/ingest/transcript`, {
    method: 'POST',
    headers: { ...authHeaders(c.token), 'idempotency-key': idempotencyKey },
    body: JSON.stringify({
      event: 'session_end',
      session_id: opts.sessionId,
      project_id: opts.projectId,
      agent_type: opts.agentType,
      captured_at: new Date().toISOString(),
      turns: opts.turns,
      client_scrub_applied: false,
      client_scrub_hits: 0,
      client_version: 'perf-harness/0.1',
      client_scrub_version: 'none',
      wire_version: 'v1.0',
    }),
  });
  const body = (await res.json()) as { ok: boolean; session_id: string; extraction_job_id?: string };
  return { status: res.status, body };
}
