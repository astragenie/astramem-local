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

/**
 * Per-request timeout for the digest poll.
 *
 * WHY THIS EXISTS (2026-07-14 incident): this fetch had no timeout and no abort
 * signal. `waitForSamplesDistilled` polls it in a loop whose deadline is only
 * checked BETWEEN outer iterations — so a single digest request that never
 * settles parks the loop inside this `await` forever, and the caller's 15-minute
 * distill timeout can never be reached. It is not a timeout that fired late; it
 * is a timeout that STRUCTURALLY CANNOT FIRE.
 *
 * Observed: a full-suite LoCoMo run sat here for 90 minutes with its ingest
 * already complete (272/272 transcripts, 2521 atoms on disk). One socket open to
 * its own daemon, zero to the answer provider, CPU flat. The run would never have
 * produced a score.
 *
 * A bounded request is what makes the caller's deadline reachable. Keep both:
 * this bounds ONE request, the caller bounds the WHOLE wait.
 */
export const DIGEST_TIMEOUT_MS = Number(process.env.ASTRA_EVAL_DIGEST_TIMEOUT_MS ?? 30_000);

/**
 * `timeoutMs` lets the CALLER shorten this bound to whatever time it has left.
 *
 * A fixed 30s bound is not enough on its own: a poll loop that enters this await
 * one millisecond before its own deadline still blocks for the full 30s, so the
 * loop's deadline is still overshot — just by less. The caller must be able to say
 * "I have 200ms left, do not exceed it." (My first pass at this fix had the fixed
 * bound only, and the hung-request test below caught it. Worth stating plainly:
 * bounded-but-not-by-the-right-clock is still unbounded from the caller's view.)
 */
export async function sessionDigest(
  client: DaemonClientOpts,
  sessionId: string,
  timeoutMs: number = DIGEST_TIMEOUT_MS,
): Promise<SessionDigest | null> {
  const res = await fetch(`${client.baseUrl}/sessions/${encodeURIComponent(sessionId)}/digest`, {
    headers: authHeaders(client.token),
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
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
