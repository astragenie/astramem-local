/**
 * LoCoMo session dates are "H:MM am/pm on D Month, YYYY" (e.g. "1:56 pm on 8
 * May, 2023") -- a different format from LongMemEval's "YYYY/MM/DD (Dow)
 * HH:MM" (see ../../longmemeval/lib/dates.ts), with no timezone marker.
 * Same methodology assumption as the LongMemEval adapter: treat every
 * timestamp as UTC for determinism across machines/runs. All 287 unique
 * date strings in the real locomo10.json (checked live 2026-07-10) match
 * this exact shape -- no alternate format observed.
 */
const LOCOMO_DATE_RE = /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s*(\d{4})$/i;

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Parse a LoCoMo `session_N_date_time` string into an ISO-8601 UTC instant
 *  (`captured_at` requires offset-bearing ISO-8601 -- see the daemon's
 *  CanonicalIngestSchema and search.ts's parseAsOf, same contract the
 *  LongMemEval adapter's envelope relies on). */
export function parseLocomoDateTime(raw: string): string {
  const m = LOCOMO_DATE_RE.exec(raw.trim());
  if (!m) throw new Error(`unparseable LoCoMo date: ${JSON.stringify(raw)}`);
  const [, hRaw, minute, ampm, day, monthName, year] = m;
  let hour = Number(hRaw);
  const isPm = ampm!.toLowerCase() === 'pm';
  if (hour === 12) hour = isPm ? 12 : 0;
  else if (isPm) hour += 12;
  const month = MONTHS[monthName!.toLowerCase()];
  if (month === undefined) throw new Error(`unrecognized month name in LoCoMo date: ${JSON.stringify(raw)}`);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(Number(day))}T${pad(hour)}:${minute}:00.000Z`;
}
