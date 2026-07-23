/**
 * FEAT-477: proxy-turn correlation — an independent SECOND implicit-
 * usefulness signal (ADR-010 v1.x), alongside `runImplicitPositivePass`'s
 * cross-query-survival heuristic (src/storage/usefulness.ts). That signal
 * asks "did this atom keep getting served without ever being corrected?" —
 * this one asks a narrower, more direct question: "does this atom's own
 * content show up again in a REAL conversation the agent had shortly after
 * it was served?" Both are heuristics (neither is a substitute for the
 * explicit mark_memory_used/submit_feedback channel, which this module never
 * touches), and both are independent of each other — granting one never
 * blocks or subsumes the other; each guards its own at-most-once-per-atom
 * idempotency via its own `basis` tag (see `PROXY_TURN_CORRELATION_BASIS`).
 *
 * Why "correlation" and not "join": the LLM proxy capture fork
 * (src/capture/proxy.ts) mints a fresh random `session_id` per EXCHANGE —
 * that module's own doc comment states plainly there is no proxy-side
 * session correlator at all (headers are structurally excluded; the body
 * carries no session concept of its own). A recall/search call (MCP tool,
 * REST /search, /recall/pack) and the proxy-captured LLM turns that follow
 * it in the SAME real conversation therefore share NO stable join key. The
 * only signal available is TIME PROXIMITY (a proxy-captured atom created
 * shortly after an atom was served) plus TEXT OVERLAP (the served atom's own
 * content showing up again in that later atom) — both approximate, both
 * heuristic, which is why this is a measurement/scoring aid, never a hard
 * join.
 *
 * "Subsequent proxy-captured turns" in practice means "subsequent atoms
 * distilled FROM proxy-captured turns" (`memories.capture_source = 'proxy'`,
 * migrations 024/026) — raw turn text itself is never durably queryable: it
 * lives only transiently in the ingest spool (src/ingest/spool.ts) until
 * drained and distilled into atoms, then deleted. An atom's own
 * `normalized_text` is the only durable trace of what was actually said,
 * which is exactly what this module correlates against.
 *
 * Out of scope (FEAT-477): this module never reads or writes `fuse.ts`,
 * `recall/pack.ts`, or `search.ts` — it is a background measurement pass
 * over `memory_events`/`memories`, wired into ranking (if ever) only via the
 * SAME `recall_used`/heuristic plumbing `runImplicitPositivePass` already
 * uses, which stays behind its own config opt-in. Measure first.
 */
import type { DB } from './db.js';
import { recordRecallUsed } from './usefulness.js';
import { safeJsonColumn } from './json-guard.js';

/**
 * Tags every grant this module makes. Lets a human reading raw
 * `memory_events` rows (or `feedbackLoopSummary`'s `usedHeuristicDistinct`
 * bucket) tell this mechanism apart from `runImplicitPositivePass`'s own
 * `'no_correction_survival'` basis, and lets THIS pass's own
 * at-most-once-per-atom guard (below) stay scoped to itself without also
 * excluding an atom the OTHER heuristic already granted — see module doc.
 */
export const PROXY_TURN_CORRELATION_BASIS = 'proxy_turn_correlation';

/** Defensive scan ceilings, independent of `maxGrantsPerRun` — this pass
 *  cannot push its grant cap into the SQL LIMIT the way
 *  `runImplicitPositivePass` does (the overlap test that decides a grant
 *  runs in JS, after both queries return), so a candidate flood (a large
 *  `recall_served` backlog, or a large proxy-captured corpus) must be capped
 *  independently or the JS-side nested comparison has no upper bound. Same
 *  "every background pass is capped, visibly" posture as the FEAT-482
 *  incident's `maxPerRun`/`maxWallClockMs` guards. */
export const DEFAULT_MAX_CANDIDATES_SCANNED = 2000;
export const DEFAULT_MAX_PROXY_ATOMS_SCANNED = 2000;

export interface ProxyTurnCorrelationOpts {
  /** Trailing lookback, in days, bounding how far back a `recall_served`
   *  event is even considered a candidate — mirrors
   *  `runImplicitPositivePass`'s `windowDays` (same rationale: an unbounded
   *  scan of `memory_events` back to the beginning of time is the #226
   *  failure shape). */
  windowDays: number;
  /** How long after an atom was served a proxy-captured atom still counts
   *  as "possibly the same live conversation" (ms). Generous by design — a
   *  real coding-agent turn can take minutes (tool calls, a long edit) — but
   *  bounded, so a proxy atom created hours later (an unrelated, later
   *  session) is never wrongly credited. */
  correlationWindowMs: number;
  /** Minimum token-containment overlap (0..1, see `tokenContainment` below)
   *  between a served atom's `normalized_text` and a later proxy-captured
   *  atom's `normalized_text` to count as correlated. */
  minOverlap: number;
  /** Batch cap on GRANTS per sweep (not candidates scanned) — mirrors the
   *  contradiction-detection `maxPerRun` precedent (FEAT-482 incident): a
   *  bounded background pass, never an unbounded one. */
  maxGrantsPerRun: number;
  /** Defensive ceiling on distinct `recall_served` atoms considered per run.
   *  Defaults to {@link DEFAULT_MAX_CANDIDATES_SCANNED}. */
  maxCandidatesScanned?: number;
  /** Defensive ceiling on `capture_source = 'proxy'` atoms considered per
   *  run. Defaults to {@link DEFAULT_MAX_PROXY_ATOMS_SCANNED}. */
  maxProxyAtomsScanned?: number;
}

export interface ProxyTurnCorrelationResult {
  /** recall_served atoms eligible to check this run (not yet corrected, not
   *  yet granted by THIS mechanism, within the trailing window, bounded by
   *  `maxCandidatesScanned`) — before the text-overlap test, so this can be
   *  LARGER than `granted`. Unlike `runImplicitPositivePass` (whose SQL
   *  LIMIT makes `candidates === granted` always), this pass's cap applies
   *  AFTER the overlap check runs in JS, not before it — a materially
   *  different result shape, deliberately not mirrored byte-for-byte. */
  candidates: number;
  /** Atoms that actually cleared the overlap threshold against a
   *  time-correlated proxy atom and received a new heuristic recall_used
   *  event this pass, capped at `maxGrantsPerRun`. */
  granted: number;
  /**
   * True when this DB has ZERO `capture_source = 'proxy'` atoms at all — the
   * proxy is off, or on but nothing has ever been captured. FEAT-477 AC:
   * this must read as "nothing to correlate against", never as "0% of
   * served memories were used" — callers MUST check this before treating
   * `granted === 0` as a negative signal.
   */
  proxyActivityAbsent: boolean;
}

/**
 * Fraction of the SMALLER significant-token set found in the LARGER one —
 * same measure `src/distill/locate-evidence.ts`'s `tokenContainment` uses
 * for its own atom-vs-transcript fuzzy match, reimplemented locally rather
 * than imported (that module's own doc comment: duplicating ~20 lines here
 * is cheaper than coupling a storage-layer background pass to a distill-
 * layer matcher answering a different question — same call this module
 * makes). Deliberately containment-based rather than a strict Jaccard
 * ratio: a short served atom ("Postgres pool size is 20") fully contained
 * inside a much longer proxy-captured atom (an extracted fact paraphrasing
 * a whole reply) should still count as a strong match even though the union
 * of the two token sets is mostly the longer atom's own text.
 */
function normalizeTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2); // drop 1-2 char tokens — too common to be signal
}

function tokenContainment(a: string, b: string): number {
  const ta = new Set(normalizeTokens(a));
  const tb = new Set(normalizeTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let shared = 0;
  for (const t of small) if (big.has(t)) shared++;
  return shared / small.size;
}

interface ServedCandidateRow {
  atomId: string;
  servedAt: number;
  text: string;
}

interface ProxyAtomRow {
  id: string;
  createdAt: number;
  text: string;
}

/**
 * Run one sweep. Has no config dependency of its own and always runs when
 * called — the enabled-check lives at the call site, matching
 * `runImplicitPositivePass`'s own documented split (see that function's doc
 * comment in src/storage/usefulness.ts). Not wired to any scheduler by this
 * slice (FEAT-477 is measurement-first; wiring a cadence needs a new
 * `config.search.usefulness.*` block, out of this slice's file scope) — a
 * caller (test, or a future cleanup-handler wire-up) invokes this directly.
 */
export function runProxyTurnCorrelationPass(
  db: DB,
  opts: ProxyTurnCorrelationOpts,
  now: number = Date.now(),
): ProxyTurnCorrelationResult {
  const proxyActive = db.prepare(`SELECT 1 AS x FROM memories WHERE capture_source = 'proxy' LIMIT 1`).get();
  if (!proxyActive) {
    return { candidates: 0, granted: 0, proxyActivityAbsent: true };
  }

  const payload = safeJsonColumn('payload_json');
  const windowStartMs = now - opts.windowDays * 24 * 60 * 60 * 1000;
  const maxCandidates = opts.maxCandidatesScanned ?? DEFAULT_MAX_CANDIDATES_SCANNED;
  const maxProxyAtoms = opts.maxProxyAtomsScanned ?? DEFAULT_MAX_PROXY_ATOMS_SCANNED;

  const candidates = db.prepare(`
    SELECT e.atom_id AS atomId, MIN(e.created_at) AS servedAt, m.normalized_text AS text
    FROM memory_events e
    JOIN memories m ON m.id = e.atom_id
    WHERE e.event_type = 'usefulness'
      AND json_extract(${payload},'$.family') = 'recall_served'
      AND e.created_at >= ?
      AND e.atom_id NOT IN (
        SELECT atom_id FROM memory_events
        WHERE event_type = 'usefulness' AND json_extract(${payload},'$.family') = 'memory_corrected'
      )
      AND e.atom_id NOT IN (
        SELECT atom_id FROM memory_events
        WHERE event_type = 'usefulness' AND json_extract(${payload},'$.family') = 'recall_used'
          AND json_extract(${payload},'$.basis') = ?
      )
    GROUP BY e.atom_id
    LIMIT ?
  `).all(windowStartMs, PROXY_TURN_CORRELATION_BASIS, maxCandidates) as ServedCandidateRow[];

  if (candidates.length === 0) {
    return { candidates: 0, granted: 0, proxyActivityAbsent: false };
  }

  const earliestServedAt = Math.min(...candidates.map(c => c.servedAt));
  const proxyAtoms = db.prepare(`
    SELECT id, created_at AS createdAt, normalized_text AS text
    FROM memories
    WHERE capture_source = 'proxy' AND created_at >= ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(earliestServedAt, maxProxyAtoms) as ProxyAtomRow[];

  let granted = 0;
  for (const candidate of candidates) {
    if (granted >= opts.maxGrantsPerRun) break;
    const windowEnd = candidate.servedAt + opts.correlationWindowMs;
    const matched = proxyAtoms.some(p =>
      p.createdAt > candidate.servedAt &&
      p.createdAt <= windowEnd &&
      p.id !== candidate.atomId && // a proxy atom never "correlates" with itself
      tokenContainment(candidate.text, p.text) >= opts.minOverlap,
    );
    if (!matched) continue;
    recordRecallUsed(db, {
      atomId: candidate.atomId,
      surface: 'system',
      signal: 'heuristic',
      basis: PROXY_TURN_CORRELATION_BASIS,
    });
    granted++;
  }

  return { candidates: candidates.length, granted, proxyActivityAbsent: false };
}

export interface ProxyCorrelationSummary {
  /** distinct atoms with a `recall_served` event, all-time. */
  servedDistinct: number;
  /** distinct atoms with a `recall_used`/heuristic/basis=proxy_turn_correlation
   *  event, all-time — i.e. this mechanism's own contribution, isolated from
   *  the explicit channel and from the OTHER heuristic (cross-query
   *  survival). */
  proxyCorrelatedDistinct: number;
  /** True when this DB has ZERO capture_source='proxy' atoms at all — see
   *  `ProxyTurnCorrelationResult.proxyActivityAbsent` for the same
   *  never-a-false-signal rationale; doctor's canary reads this field before
   *  treating a low/zero rate as meaningful. */
  proxyActivityAbsent: boolean;
}

/**
 * All-time summary feeding the doctor "Proxy-turn correlation" canary
 * (src/doctor/checks/proxy-turn-correlation.ts) — read-only, grants nothing.
 * Mirrors `feedbackLoopSummary`'s all-time (no window) posture in
 * src/storage/usefulness.ts: "has this mechanism ever correlated anything"
 * is the question, not a recency-windowed rate.
 */
export function proxyCorrelationSummary(db: DB): ProxyCorrelationSummary {
  const proxyActive = db.prepare(`SELECT 1 AS x FROM memories WHERE capture_source = 'proxy' LIMIT 1`).get();
  if (!proxyActive) {
    return { servedDistinct: 0, proxyCorrelatedDistinct: 0, proxyActivityAbsent: true };
  }

  const payload = safeJsonColumn('payload_json');
  const servedDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(${payload},'$.family') = 'recall_served'
  `).get() as { n: number }).n;

  const proxyCorrelatedDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(${payload},'$.family') = 'recall_used'
      AND json_extract(${payload},'$.basis') = ?
  `).get(PROXY_TURN_CORRELATION_BASIS) as { n: number }).n;

  return { servedDistinct, proxyCorrelatedDistinct, proxyActivityAbsent: false };
}
