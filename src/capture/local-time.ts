/**
 * Local-timezone ISO-8601 formatting (2026-07-13 timezone-offset bugfix).
 *
 * Root cause: both capture paths (src/capture/claude.ts, src/capture/
 * proxy.ts) stamped `captured_at` via `new Date().toISOString()`, which
 * always renders the UTC calendar date/time with a bare `Z` suffix —
 * `captured_at` is the ONLY place the user's local capture offset ever
 * existed, and this discarded it unconditionally at the moment of capture.
 * Every downstream consumer (PipelineContext.capturedAtMs, the stage-5
 * `sessionDateIso` extraction anchor added by the 2026-07-13 temporal-
 * grounding fix) therefore had no way to recover the user's local calendar
 * date — a user capturing at 21:00 in UTC-8 is at 05:00 UTC the NEXT day, so
 * "yesterday" in that session resolved one day off.
 *
 * `localIsoString` instead renders the process's LOCAL wall-clock time with
 * an explicit numeric offset (e.g. `2026-07-13T21:00:00.000-08:00`), or a
 * bare `Z` when the local offset is exactly zero (UTC users see byte-
 * identical output to before this fix). This is still valid ISO-8601 and
 * `Date.parse`/`new Date(...)` resolve it to the IDENTICAL epoch a `Z`-
 * suffixed string for the same instant would have — every existing consumer
 * that only ever does `new Date(captured_at).getTime()` (src/server/routes/
 * ingest.ts) is unaffected. CanonicalIngestSchema's `captured_at:
 * z.string().datetime({ offset: true })` already accepts either form.
 *
 * Deliberately its own tiny module rather than living inside claude.ts or
 * proxy.ts: proxy.ts's file header states it must not depend on claude.ts,
 * and this formatter has nothing tool-specific about it — both capture
 * modules import it independently.
 */
export function localIsoString(date: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const millis = pad(date.getMilliseconds(), 3);

  // getTimezoneOffset() is UTC minus local, in minutes (positive west of
  // UTC) — negate it to get the conventional sign for an ISO-8601 offset
  // suffix (e.g. UTC-8 → getTimezoneOffset() === 480 → offsetMinutes === -480 → "-08:00").
  const offsetMinutes = -date.getTimezoneOffset();
  const offset = offsetMinutes === 0
    ? 'Z'
    : `${offsetMinutes > 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}${offset}`;
}
