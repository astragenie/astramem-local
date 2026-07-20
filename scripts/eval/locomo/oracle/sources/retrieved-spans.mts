/**
 * `retrieved-spans` `EvidenceSource` — takes the SAME atoms `retrieved-atoms`
 * would return for this question, then maps each one back to its SOURCE
 * conversation turn and substitutes the RAW TURN TEXT for the atom's own
 * (synthesized/paraphrased) text.
 *
 * WHAT THIS MEASURES (v2 plan §Phase 1 — see `harness.mts`'s header):
 * `retrieved-atoms` vs `retrieved-spans` isolates whether ATOMIZATION itself
 * hurt the answerer, holding retrieval fixed — same set of retrieved items,
 * only the surface form changes (atom prose vs. the verbatim turn it came
 * from).
 *
 * ── The back-map is FUZZY, and that fuzziness is itself the finding ───────
 *
 * `SearchHit` (`../../../shared/daemon-client.js`) does NOT carry the atom's
 * `evidence` quote on the wire (verified against `src/search/search.ts`'s
 * `SearchHit` interface and the eval client's own narrower type) — so this
 * source fetches it out-of-band via `GET /memory/:id` (authenticated with
 * the same `ctx.daemonClient` bearer token every other call in this harness
 * uses), which returns the full `Memory` row including `evidence?: string |
 * null` (`src/storage/memories.ts`). That quote is then matched as a plain
 * SUBSTRING against every turn's raw `text` field in the sample's
 * conversation (see `src/distill/prompts/extract.ts`'s extraction-prompt
 * contract: "evidence" is an EXACT verbatim quote from the source turn,
 * never a paraphrase — so a substring match against the turn's own `text`
 * is the correct match target, not the flattened `role: text` line the
 * distill pipeline feeds the model).
 *
 * Three things can make a retrieved atom NOT resolve to a real turn, and all
 * three fall back to the atom's own text (never dropped, never an error —
 * this source always returns exactly one hit per input hit, modulo dedup):
 *   1. The atom has no `evidence` quote at all (optional field — most
 *      pre-decision/lesson atom types never populate it, see extract.ts).
 *   2. `GET /memory/:id` 404s (e.g. the atom was superseded/purged between
 *      ingest and this read).
 *   3. The quote is populated but doesn't substring-match any turn in this
 *      sample — a genuine extraction/quoting defect worth knowing about,
 *      not something to paper over.
 * The match RATE (matched vs. fallback) is logged every call (see
 * `logMatchRate` below) — a low rate is itself evidence that atomization is
 * losing traceability back to source text, independent of whatever the
 * factorial table's score comparison shows.
 *
 * `EvidenceSource.id` MUST equal the filename stem — this file's id is
 * `retrieved-spans`, matching `retrieved-spans.mts`.
 */
import type { EvidenceSource } from '../harness.mts';
import { recall, type DaemonClientOpts, type SearchHit } from '../../../shared/daemon-client.js';
import { projectIdFor } from '../../lib/envelope.js';
import { sessionNumbers, type LoCoMoSample, type LoCoMoTurn } from '../../lib/types.js';

/** One conversation turn plus the session-level date/time string it belongs
 *  to (LoCoMo turns don't carry their own timestamp — only the session
 *  does, see `lib/types.ts`'s `LoCoMoConversation`). */
export interface FlatTurn {
  turn: LoCoMoTurn;
  dateTimeRaw: string;
}

/** Every turn across every session of one sample, in session/turn order —
 *  the pool a quote is matched against. Sessions with a missing turns array
 *  or missing date_time are skipped (defensive; `lib/envelope.ts`'s
 *  `buildIngestEnvelope` throws on this instead since ingest cannot proceed
 *  without both, but a read-only back-map should degrade, not crash the
 *  whole oracle cell over one malformed session). */
export function flattenSampleTurns(sample: LoCoMoSample): FlatTurn[] {
  const out: FlatTurn[] = [];
  for (const n of sessionNumbers(sample.conversation)) {
    const turns = sample.conversation[`session_${n}`];
    const dateTimeRaw = sample.conversation[`session_${n}_date_time`];
    if (!turns || !dateTimeRaw) continue;
    for (const turn of turns) out.push({ turn, dateTimeRaw });
  }
  return out;
}

/** First turn whose raw `text` contains `quote` as an exact substring
 *  (post-trim). `undefined` when `quote` is empty/whitespace-only or no
 *  turn matches — both are "no match", handled identically by the caller. */
export function findTurnByQuote(turns: FlatTurn[], quote: string): FlatTurn | undefined {
  const trimmed = quote.trim();
  if (!trimmed) return undefined;
  return turns.find(ft => ft.turn.text.includes(trimmed));
}

/** `"[<date>] <speaker>: <text>"`, matching `lib/envelope.ts`'s own
 *  `[shares <blip_caption>]` inline convention for image turns so a span
 *  hit reads the same way the ingested turn text did. */
export function formatTurnSpan(flat: FlatTurn): string {
  const { turn, dateTimeRaw } = flat;
  const suffix = turn.blip_caption ? ` [shares ${turn.blip_caption}]` : '';
  return `[${dateTimeRaw}] ${turn.speaker}: ${turn.text}${suffix}`;
}

interface MemoryDetailResponse {
  evidence?: string | null;
}

/** `GET /memory/:id` — the one route (`src/server/routes/memory.ts`) that
 *  exposes an atom's `evidence` quote; `/recall`'s `SearchHit` doesn't carry
 *  it (see this file's header). Returns `null` (not an error) for a missing
 *  quote OR a 404 (superseded/purged atom) — both are legitimate "no quote
 *  to match on" outcomes for this source, not broken-run conditions. */
export async function fetchEvidenceQuote(client: DaemonClientOpts, id: string): Promise<string | null> {
  const res = await fetch(`${client.baseUrl}/memory/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${client.token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`retrieved-spans: GET /memory/${id} failed: HTTP ${res.status} — ${await res.text()}`);
  }
  const body = (await res.json()) as MemoryDetailResponse;
  return typeof body.evidence === 'string' && body.evidence.trim().length > 0 ? body.evidence : null;
}

// ── Match-rate tracking (a finding in its own right — see file header) ────

export interface MatchRateStats {
  matched: number;
  fallback: number;
  calls: number;
}

const stats: MatchRateStats = { matched: 0, fallback: 0, calls: 0 };

/** Exposed for the standalone unit check (this source's `hitsFor` needs a
 *  live store to exercise end-to-end — see the dispatch note in this file's
 *  PR — so the back-map logic is verified in isolation against this counter
 *  instead). Never imported by `harness.mts` or any other production path. */
export function getMatchRateStats(): MatchRateStats {
  return { ...stats };
}

/** Test-only reset — same rationale as `getMatchRateStats`. */
export function resetMatchRateStats(): void {
  stats.matched = 0;
  stats.fallback = 0;
  stats.calls = 0;
}

function recordMatch(matched: boolean): void {
  if (matched) stats.matched += 1;
  else stats.fallback += 1;
}

function logMatchRate(): void {
  stats.calls += 1;
  const total = stats.matched + stats.fallback;
  const pct = total === 0 ? 0 : (stats.matched / total) * 100;
  // stderr, not stdout — keeps the harness's own per-cell stdout summary
  // (see harness.mts's runOracleFactorial) uncluttered while still landing
  // in captured run logs.
  console.error(
    `[retrieved-spans] evidence-quote match rate: ${stats.matched}/${total} (${pct.toFixed(1)}%) resolved to a ` +
      `source turn; ${stats.fallback} fell back to atom text — cumulative across ${stats.calls} question(s).`,
  );
}

const retrievedSpans: EvidenceSource = {
  id: 'retrieved-spans',
  needsStore: true,
  async hitsFor(qa, sampleId, ctx) {
    if (!ctx.daemonClient) {
      throw new Error(
        'retrieved-spans: EvidenceContext.daemonClient is undefined — the harness should have mounted a ' +
          'store daemon because this source declares needsStore:true. This is a harness wiring bug, not a ' +
          'valid "no evidence" result.',
      );
    }
    const client = ctx.daemonClient;

    // Same retrieval call as retrieved-atoms.mts / answer.mts — this source
    // varies ONLY what happens to the hits after retrieval, never retrieval
    // itself (see harness.mts's header: "each cell varies ONLY what
    // produces hits").
    const atomHits = await recall(client, {
      text: qa.question,
      limit: ctx.k,
      filters: { project: projectIdFor(sampleId) },
    });
    if (atomHits.length === 0) return [];

    const sample = ctx.dataset.find(s => s.sample_id === sampleId);
    if (!sample) {
      throw new Error(
        `retrieved-spans: sample "${sampleId}" not found in EvidenceContext.dataset (${ctx.dataset.length} ` +
          `sample(s) loaded) — the harness should always pass the full sampled dataset.`,
      );
    }
    const turns = flattenSampleTurns(sample);

    // Fetch every hit's evidence quote concurrently (bounded by ctx.k, which
    // is small — same order of magnitude as a single /recall call) rather
    // than serially, so this source's added latency over retrieved-atoms
    // stays close to one extra round-trip, not k of them back to back.
    const quotes = await Promise.all(atomHits.map(hit => fetchEvidenceQuote(client, hit.id)));

    const seen = new Set<string>();
    const out: SearchHit[] = [];
    for (let i = 0; i < atomHits.length; i++) {
      const hit = atomHits[i]!;
      const quote = quotes[i] ?? null;
      const matchedTurn = quote ? findTurnByQuote(turns, quote) : undefined;

      const text = matchedTurn ? formatTurnSpan(matchedTurn) : hit.text;
      const dedupeKey = matchedTurn ? `turn:${matchedTurn.turn.dia_id}` : `atom:${hit.id}`;
      recordMatch(matchedTurn !== undefined);

      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({ ...hit, text });
    }
    logMatchRate();
    return out;
  },
};

export default retrievedSpans;
