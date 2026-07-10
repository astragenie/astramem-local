/**
 * Thin HTTP client for the three astramemory-local routes this harness
 * needs. Field names verified against src/server/routes/{ingest,search,digest}.ts
 * (2026-07-08) — see docs/eval/longmemeval-plan.md section 3 for the wire
 * mapping this mirrors.
 */

export interface CanonicalIngestEnvelope {
  event: 'session_end';
  session_id: string;
  project_id: string;
  agent_type?: string;
  captured_at: string;
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
  client_scrub_applied: boolean;
  client_scrub_hits: number;
  client_version: string;
  client_scrub_version: string;
  wire_version: string;
}

export interface IngestResponse {
  ok: boolean;
  summary_memory_id?: string;
  session_id: string;
  idempotent: boolean;
  extraction_job_id?: string;
  error?: string;
  detail?: string;
}

export interface SessionDigest {
  session_id: string;
  status: 'pending' | 'ready';
  counts: Record<string, number>;
  memories: Array<{ id: string; type: string; text: string }>;
}

export interface SearchHit {
  id: string;
  type: string;
  text: string;
  score: number;
  source: string;
}

export interface RecallFilters {
  project?: string;
  as_of?: string;
}

export interface DaemonClientOpts {
  baseUrl: string;
  token: string;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

export async function ingestTranscript(
  client: DaemonClientOpts,
  envelope: CanonicalIngestEnvelope,
  idempotencyKey: string,
): Promise<{ status: number; body: IngestResponse }> {
  const res = await fetch(`${client.baseUrl}/ingest/transcript`, {
    method: 'POST',
    headers: { ...authHeaders(client.token), 'idempotency-key': idempotencyKey },
    body: JSON.stringify(envelope),
  });
  const body = (await res.json()) as IngestResponse;
  return { status: res.status, body };
}

export async function sessionDigest(client: DaemonClientOpts, sessionId: string): Promise<SessionDigest | null> {
  const res = await fetch(`${client.baseUrl}/sessions/${encodeURIComponent(sessionId)}/digest`, {
    headers: authHeaders(client.token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /sessions/${sessionId}/digest failed: HTTP ${res.status}`);
  return (await res.json()) as SessionDigest;
}

export async function recall(
  client: DaemonClientOpts,
  opts: { text: string; limit: number; filters?: RecallFilters },
): Promise<SearchHit[]> {
  const res = await fetch(`${client.baseUrl}/recall`, {
    method: 'POST',
    headers: authHeaders(client.token),
    body: JSON.stringify({ text: opts.text, limit: opts.limit, filters: opts.filters }),
  });
  if (!res.ok) throw new Error(`POST /recall failed: HTTP ${res.status} — ${await res.text()}`);
  const body = (await res.json()) as { hits: SearchHit[] };
  return body.hits;
}

export interface HealthResponse {
  ok: boolean;
  status?: string;
  version?: string;
}

export async function health(baseUrl: string): Promise<HealthResponse> {
  const res = await fetch(`${baseUrl}/health`);
  if (!res.ok) throw new Error(`GET /health failed: HTTP ${res.status}`);
  return (await res.json()) as HealthResponse;
}
