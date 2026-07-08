/**
 * LongMemEval dates are "YYYY/MM/DD (Dow) HH:MM" with no timezone marker.
 * The dataset doesn't say which zone it was authored in, so — for
 * determinism across machines/runs — we treat every timestamp as UTC. This
 * is a methodology assumption, not a discovered fact; see README's
 * "methodology notes" for the implication (as_of / captured_at comparisons
 * are self-consistent within a run since every date in the dataset gets the
 * same treatment, but would not line up with a wall-clock "real" timezone).
 */
const LME_DATE_RE = /^(\d{4})\/(\d{2})\/(\d{2}) \(\w+\) (\d{2}):(\d{2})$/;

/** Parse a LongMemEval date string into an ISO-8601 UTC instant string
 *  (`captured_at`/`as_of` both require offset-bearing ISO-8601 — see
 *  ingest.ts's CanonicalIngestSchema and search.ts's parseAsOf). */
export function parseLongMemEvalDate(raw: string): string {
  const m = LME_DATE_RE.exec(raw.trim());
  if (!m) throw new Error(`unparseable LongMemEval date: ${JSON.stringify(raw)}`);
  const [, y, mo, d, h, mi] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:00.000Z`;
}
