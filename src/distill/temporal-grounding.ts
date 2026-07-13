/**
 * Deterministic relative-date grounding — a regex + date-arithmetic post-pass
 * applied to extracted atom TEXT after the LLM call returns (05-extract.ts's
 * extractChunk), on top of (not instead of) the existing prompt-level
 * instruction (prompts/extract.ts's "Date grounding" rule).
 *
 * WHY THIS EXISTS (WS1 diagnosis, 2026-07-13): the prompt-level instruction is
 * wired correctly end-to-end — `sessionDateIso` reaches every extraction call
 * as a literal "Observation date: <date>" line (05-extract.ts's callExtract)
 * — but real memory rows from a LoCoMo run show atom TEXT still containing
 * raw "Caroline attended an LGBTQ support group yesterday..." while that same
 * row's `valid_from` (derived independently from `capturedAtMs`, not from the
 * resolved text) was correct. The anchor date was available; the local
 * extraction model (qwen3:8b) simply did not reliably rewrite the relative
 * phrase in the JSON `text` field it returned. The LoCoMo answerer
 * (scripts/eval/locomo/answer.mts) — and any real recall caller — only ever
 * sees `text`, never `valid_from`, so an un-rewritten "yesterday" is
 * unanswerable regardless of how correct the bitemporal column is. A
 * deterministic pass does not depend on model compliance.
 *
 * Deliberately narrow scope — only patterns with ONE unambiguous absolute
 * resolution are handled: same-day (yesterday/today/tomorrow), month
 * (last/this/next month), year (last/this/next year), and named-weekday
 * (last/next `<Weekday>`). Week-granularity phrases ("last week", "this
 * weekend") are deliberately NOT resolved here: which day within the week to
 * anchor on (week-start Monday? Sunday? the anchor's own weekday?) has no
 * single unambiguous answer, and LoCoMo's own gold answers for that
 * granularity are themselves relative-to-a-later-reference-point phrasing
 * ("The week before 6 July 2023") rather than a clean absolute date — a
 * forced single-day guess is as likely to be wrong as the unresolved phrase.
 * Left as a follow-on once there is a concrete pattern to anchor the
 * granularity choice on, not attempted here.
 *
 * Output is natural-language ("D Month YYYY" / "Month YYYY" / "YYYY"), NOT
 * ISO-8601. This matters beyond style: LoCoMo's token-F1 scorer
 * (scripts/eval/locomo/judge/metrics.mts) strips ALL punctuation, including
 * hyphens, before tokenizing — an ISO date like "2023-05-14" collapses to the
 * single glued token "20230514", which shares zero tokens with a gold answer
 * like "7 May 2023" ("7", "may", "2023"). Any date substitution that isn't
 * word-tokenized the way natural language is would score no better than
 * leaving the relative phrase unresolved.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

function formatDay(d: Date): string {
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatMonthYear(d: Date): string {
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function addDaysUtc(anchor: Date, days: number): Date {
  const d = new Date(anchor.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addMonthsUtc(anchor: Date, months: number): Date {
  const d = new Date(anchor.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function addYearsUtc(anchor: Date, years: number): Date {
  const d = new Date(anchor.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

/** Nearest occurrence of `targetWeekday` (0=Sunday..6=Saturday) strictly
 * before `anchor` ("last Friday" said ON a Friday means 7 days ago, not
 * today — never returns the anchor's own day). */
function lastWeekday(anchor: Date, targetWeekday: number): Date {
  const diff = ((anchor.getUTCDay() - targetWeekday + 7) % 7) || 7;
  return addDaysUtc(anchor, -diff);
}

/** Nearest occurrence of `targetWeekday` strictly after `anchor` — mirror of
 * lastWeekday, never returns the anchor's own day. */
function nextWeekday(anchor: Date, targetWeekday: number): Date {
  const diff = ((targetWeekday - anchor.getUTCDay() + 7) % 7) || 7;
  return addDaysUtc(anchor, diff);
}

interface Pattern {
  re: RegExp;
  resolve: (match: RegExpMatchArray, anchor: Date) => string;
}

const PATTERNS: Pattern[] = [
  { re: /\byesterday\b/gi, resolve: (_m, anchor) => formatDay(addDaysUtc(anchor, -1)) },
  { re: /\btomorrow\b/gi, resolve: (_m, anchor) => formatDay(addDaysUtc(anchor, 1)) },
  { re: /\btoday\b/gi, resolve: (_m, anchor) => formatDay(anchor) },
  { re: /\blast year\b/gi, resolve: (_m, anchor) => String(addYearsUtc(anchor, -1).getUTCFullYear()) },
  { re: /\bnext year\b/gi, resolve: (_m, anchor) => String(addYearsUtc(anchor, 1).getUTCFullYear()) },
  { re: /\bthis year\b/gi, resolve: (_m, anchor) => String(anchor.getUTCFullYear()) },
  { re: /\blast month\b/gi, resolve: (_m, anchor) => formatMonthYear(addMonthsUtc(anchor, -1)) },
  { re: /\bnext month\b/gi, resolve: (_m, anchor) => formatMonthYear(addMonthsUtc(anchor, 1)) },
  { re: /\bthis month\b/gi, resolve: (_m, anchor) => formatMonthYear(anchor) },
  {
    re: /\blast (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
    resolve: (m, anchor) => formatDay(lastWeekday(anchor, WEEKDAY_NAMES.indexOf(m[1]!.toLowerCase() as (typeof WEEKDAY_NAMES)[number]))),
  },
  {
    re: /\bnext (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
    resolve: (m, anchor) => formatDay(nextWeekday(anchor, WEEKDAY_NAMES.indexOf(m[1]!.toLowerCase() as (typeof WEEKDAY_NAMES)[number]))),
  },
];

export interface GroundingResult {
  text: string;
  /** True iff at least one relative-date pattern was found and replaced. */
  grounded: boolean;
}

/**
 * Replace every recognized relative-date expression in `text` with its
 * absolute resolution against `sessionDateIso` (a `YYYY-MM-DD` calendar
 * date — the same anchor already threaded into the extraction prompt itself,
 * see this module's header). Returns `text` UNCHANGED (`grounded: false`)
 * when `sessionDateIso` is missing/malformed or no pattern matches — never
 * invents a date from nothing, mirroring the prompt's own "keep the original
 * relative phrasing rather than inventing an absolute date" rule.
 */
export function groundRelativeDates(text: string, sessionDateIso: string | undefined): GroundingResult {
  if (!sessionDateIso || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDateIso)) {
    return { text, grounded: false };
  }
  const anchor = new Date(`${sessionDateIso}T00:00:00.000Z`);
  if (Number.isNaN(anchor.getTime())) return { text, grounded: false };

  let grounded = false;
  let result = text;
  for (const { re, resolve } of PATTERNS) {
    const next = result.replace(re, (...args) => {
      grounded = true;
      // RegExpMatchArray-shaped enough for resolve()'s use (m[1] on the
      // weekday patterns) — replace()'s callback args are [match, ...groups,
      // offset, string], which is what a real exec() match array holds too.
      return resolve(args as unknown as RegExpMatchArray, anchor);
    });
    result = next;
  }
  return { text: result, grounded };
}
