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
 * (last/this/next month), year (last/this/next year), named-weekday
 * (last/next `<Weekday>`), and a BARE weekday used in past-tense narration
 * ("...on Friday..." with no last/next prefix — resolved to the nearest
 * occurrence AT OR BEFORE the anchor, since a bare weekday in narration
 * almost always refers to a day already in the narrated past, unlike
 * "last <Weekday>"/"next <Weekday>" which are explicit and directional).
 *
 * Week-granularity phrases ("last week", "this week", "last/next weekend")
 * are resolved to a REFERENCE-POINT PHRASE ("the week before <D Month
 * YYYY>"), never to a single guessed day within the week — see "Why
 * reference-point phrasing, not a single day" below for the measured reason.
 *
 * ── Why reference-point phrasing, not a single day (measured, not guessed) ──
 *
 * An earlier draft of this module picked one specific day inside the week
 * (e.g. "last week" -> anchor minus 7 days) and left it there deliberately
 * unresolved pending measurement. Read-only F1 comparison against 8 real
 * LoCoMo bucket-(b) failures (WS1 diagnosis, 2026-07-13) using the actual
 * scorer settled it: single-day guessing scored a mean F1 of 0.469 (and was
 * WORSE than doing nothing at all on one case) versus reference-point
 * phrasing's 0.975.
 *
 * The reason isn't a scoring trick — it's that our own extraction anchor
 * (the session's capture date) turns out to be almost exactly the same
 * reference point LoCoMo's own gold answers already use ("the week before 6
 * July 2023" for an atom whose anchor is 2023-07-06 — a zero-day gap). So
 * "the week before <anchor>" is a FACTUALLY TRUE statement about the memory,
 * not a guess: it resolves exactly as much precision as we actually have
 * (a session happened in some week relative to a known date) and no more.
 * Guessing a specific day fabricates precision nobody has.
 *
 * The test applied here, and the one to keep applying before adding any
 * future pattern to this module: **does this make the MEMORY better,
 * independent of the benchmark?** "last week" in a stored memory is
 * meaningless on its own — last week relative to WHAT? The anchor was
 * always the missing information, discarded by leaving the phrase relative.
 * "the week before 6 July 2023" tells a real user something real, forever,
 * with no benchmark involved. If a future change to this module ever
 * reshapes phrasing purely to match gold's token choices rather than to
 * state a truer, more complete fact than what came in — that IS gaming the
 * benchmark, and it is forbidden here. The line: output must be true and
 * useful on its own terms, independent of how it happens to score. A
 * precision we don't actually have would fail that test even if it scored
 * well; reference-point phrasing passes it because it never claims more
 * than the anchor actually establishes.
 *
 * "recently" and other similarly vague temporal markers are deliberately
 * EXCLUDED PERMANENTLY, not just deferred — there is no anchor-relative
 * arithmetic that recovers a specific date from a word that carries no
 * distance information at all. This is not a benchmark-scoring call: this
 * module's output also lands in real users' production memory stores via
 * the same extraction pipeline, not just the LoCoMo benchmark path. A
 * hallucinated date silently written into a real memory is worse than an
 * honest unresolved one — a user has no way to discover it's wrong, and it
 * would be presented with the same confidence as a genuinely-grounded date.
 * Never add a pattern here whose resolution is a guess rather than a
 * deterministic consequence of the anchor.
 *
 * ── Guarding against non-session-relative continuations (review finding,
 * validation, 2026-07-13) ──────────────────────────────────────────────────
 *
 * A live behavior-validation pass reproduced real date FABRICATION: "Caroline
 * described the last week of the project as extremely stressful" resolved to
 * "...the the week before 15 July 2023 of the project..." — a confident,
 * precisely-formatted, and completely FALSE claim. "the last week OF THE
 * PROJECT" describes the project's own final week — a property of the
 * project's timeline, unrelated to the session capture date — not a
 * session-relative reference at all. The same construction generalizes past
 * week/weekend to every "last/next X" pattern here: "the last month of the
 * semester," "the last year of the war," "the last Friday of the month" (a
 * common recurring-event idiom) are all real English and all equally wrong
 * to resolve against the session anchor.
 *
 * Every "last/next <unit>" pattern below (year, month, week, weekend, named
 * weekday, and the bare-weekday pattern) therefore carries a negative
 * lookahead refusing to match when immediately followed by " of <noun>" —
 * the idiomatic marker that the phrase modifies a DIFFERENT referent's own
 * timeline rather than referring to session-relative time. Leaving the
 * phrase untouched in that case is always correct: an honest vague statement
 * beats a confident false one, the same principle "recently" is excluded
 * under above.
 *
 * Deliberately does NOT guard a following possessive "'s" ("last week's
 * numbers were bad," "next weekend's release") — unlike "of," a trailing
 * possessive does not change what the phrase refers to; "last week's X" is
 * still ordinary session-relative time (the numbers FROM last week), just
 * like "last week" alone. Resolving it produces grammatically dense but
 * factually correct output ("the week before 15 July 2023's numbers were
 * bad") — this is intentional and pinned by a test, not an oversight; see
 * "measure, don't guess" above — there is no confirmed case showing 's
 * continuations produce a false claim the way "of" continuations do, so no
 * guard was added for one that hasn't been demonstrated broken.
 *
 * Every "last <unit>"/"next <unit>" pattern that can idiomatically take a
 * preceding "the" ("the last week," "the last Friday," "the next weekend")
 * also optionally consumes it as part of the match, so it gets replaced
 * along with the rest of the phrase rather than left behind duplicated —
 * fixes a related cosmetic bug ("the last week of the project" — before the
 * "of" guard existed — used to become "the the week before...", a doubled
 * article) by construction: the resolution text already supplies exactly
 * the article grammar calls for (or none, for weekday/month/year
 * resolutions, which never need one), so consuming any pre-existing "the "
 * into the match and discarding it can never double it.
 *
 * Known limitation, not fixed here (regex has no discourse model): a
 * relative phrase inside quoted or reported speech ("Caroline said 'I saw
 * her last week' during the call") resolves against the SESSION anchor even
 * if the quoted speaker meant something else. In an ordinary same-session
 * transcript this is usually still correct (the quote was uttered close to
 * the session's own capture time), so it is left resolving normally rather
 * than guarded — but a transcript excerpting an OLDER quote (a message
 * forwarded from days earlier, a journal entry read aloud) could anchor
 * incorrectly. No regex-only fix exists for this; would need real discourse/
 * quote-span tracking. Flagged, not attempted.
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

/**
 * Bug fix (review finding, 2026-07-13): naive `d.setUTCMonth(d.getUTCMonth()
 * + months)` on a `Date` still carrying the ANCHOR's day-of-month OVERFLOWS
 * FORWARD whenever that day doesn't exist in the target month — e.g. a
 * 2023-07-31 anchor asking for "+1 month" lands on the nonexistent
 * "2023-08-31," which JS Date silently normalizes into 2023-09-XX instead of
 * throwing. Every caller of this function only ever reads month/year
 * (formatMonthYear discards the day), so there is no need to preserve
 * day-of-month at all — construct the 1st of the target month directly via
 * `Date.UTC` so there's no day value left to overflow.
 */
function addMonthsUtc(anchor: Date, months: number): Date {
  return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + months, 1));
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

/** Nearest occurrence of `targetWeekday` AT OR BEFORE `anchor` — unlike
 * `lastWeekday`, DOES allow returning the anchor's own day (diff 0). Used
 * only for the bare-weekday pattern ("...on Friday...", no last/next
 * prefix): past-tense narration naming a weekday with no explicit
 * last/next/this qualifier most naturally means the nearest such day not
 * later than the observation point, including today itself if today
 * happens to be that weekday. */
function nearestPastOrSameWeekday(anchor: Date, targetWeekday: number): Date {
  const diff = (anchor.getUTCDay() - targetWeekday + 7) % 7;
  return addDaysUtc(anchor, -diff);
}

interface Pattern {
  re: RegExp;
  resolve: (match: RegExpMatchArray, anchor: Date) => string;
}

// Negative lookahead: refuse to match when the phrase is immediately
// followed by " of <noun>" -- see the module header's "Guarding against
// non-session-relative continuations" for why. Spliced into each pattern's
// source below rather than duplicated as a literal in every regex.
const NOT_FOLLOWED_BY_OF = String.raw`(?!\s+of\b)`;

const PATTERNS: Pattern[] = [
  { re: /\byesterday\b/gi, resolve: (_m, anchor) => formatDay(addDaysUtc(anchor, -1)) },
  { re: /\btomorrow\b/gi, resolve: (_m, anchor) => formatDay(addDaysUtc(anchor, 1)) },
  { re: /\btoday\b/gi, resolve: (_m, anchor) => formatDay(anchor) },
  { re: new RegExp(String.raw`\b(?:the )?last year\b${NOT_FOLLOWED_BY_OF}`, 'gi'), resolve: (_m, anchor) => String(addYearsUtc(anchor, -1).getUTCFullYear()) },
  { re: new RegExp(String.raw`\b(?:the )?next year\b${NOT_FOLLOWED_BY_OF}`, 'gi'), resolve: (_m, anchor) => String(addYearsUtc(anchor, 1).getUTCFullYear()) },
  { re: new RegExp(String.raw`\bthis year\b${NOT_FOLLOWED_BY_OF}`, 'gi'), resolve: (_m, anchor) => String(anchor.getUTCFullYear()) },
  { re: new RegExp(String.raw`\b(?:the )?last month\b${NOT_FOLLOWED_BY_OF}`, 'gi'), resolve: (_m, anchor) => formatMonthYear(addMonthsUtc(anchor, -1)) },
  { re: new RegExp(String.raw`\b(?:the )?next month\b${NOT_FOLLOWED_BY_OF}`, 'gi'), resolve: (_m, anchor) => formatMonthYear(addMonthsUtc(anchor, 1)) },
  { re: new RegExp(String.raw`\bthis month\b${NOT_FOLLOWED_BY_OF}`, 'gi'), resolve: (_m, anchor) => formatMonthYear(anchor) },
  // Week-granularity -- reference-point phrasing, not a single guessed day.
  // See the module header ("Why reference-point phrasing, not a single day")
  // for the measured rationale. Only the 4 patterns actually measured
  // against real bucket-(b) cases are implemented -- "next week" was not
  // among them and is deliberately left unadded rather than assumed to
  // generalize; add it only once a real case measures it (module doc's own
  // "measure, don't guess" rule applies to this module's own construction,
  // not just to what it resolves).
  { re: new RegExp(String.raw`\b(?:the )?last week\b${NOT_FOLLOWED_BY_OF}`, 'gi'), resolve: (_m, anchor) => `the week before ${formatDay(anchor)}` },
  { re: new RegExp(String.raw`\bthis week\b${NOT_FOLLOWED_BY_OF}`, 'gi'), resolve: (_m, anchor) => `the week of ${formatDay(anchor)}` },
  { re: new RegExp(String.raw`\b(?:the )?last weekend\b${NOT_FOLLOWED_BY_OF}`, 'gi'), resolve: (_m, anchor) => `the weekend before ${formatDay(anchor)}` },
  { re: new RegExp(String.raw`\b(?:the )?next weekend\b${NOT_FOLLOWED_BY_OF}`, 'gi'), resolve: (_m, anchor) => `the weekend after ${formatDay(anchor)}` },
  {
    re: new RegExp(String.raw`\b(?:the )?last (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b${NOT_FOLLOWED_BY_OF}`, 'gi'),
    resolve: (m, anchor) => formatDay(lastWeekday(anchor, WEEKDAY_NAMES.indexOf(m[1]!.toLowerCase() as (typeof WEEKDAY_NAMES)[number]))),
  },
  {
    re: new RegExp(String.raw`\b(?:the )?next (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b${NOT_FOLLOWED_BY_OF}`, 'gi'),
    resolve: (m, anchor) => formatDay(nextWeekday(anchor, WEEKDAY_NAMES.indexOf(m[1]!.toLowerCase() as (typeof WEEKDAY_NAMES)[number]))),
  },
  // Bare weekday in past-tense narration ("...on Friday..."), no last/next
  // qualifier. MUST run after the last/next weekday patterns above: by the
  // time this pattern's turn comes, "last Friday"/"next Friday" have already
  // been rewritten to an absolute date by the earlier patterns and no longer
  // contain the bare word "Friday" for this one to (mis)match.
  {
    re: new RegExp(String.raw`\bon (sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b${NOT_FOLLOWED_BY_OF}`, 'gi'),
    resolve: (m, anchor) => `on ${formatDay(nearestPastOrSameWeekday(anchor, WEEKDAY_NAMES.indexOf(m[1]!.toLowerCase() as (typeof WEEKDAY_NAMES)[number])))}`,
  },
];

export interface GroundingResult {
  text: string;
  /** True iff at least one relative-date pattern was found and replaced. */
  grounded: boolean;
}

/**
 * True when `offset` in `fullString` starts a sentence — the very start of
 * the string, or right after `. ` / `! ` / `? ` (optionally followed by a
 * closing quote/paren before the whitespace). Used only to decide whether a
 * resolution's leading letter needs re-capitalizing (see below) — a
 * heuristic, not real sentence segmentation, but sufficient for the cases
 * that actually arise in atom text.
 */
function isSentenceStart(fullString: string, offset: number): boolean {
  const before = fullString.slice(0, offset);
  return /^\s*$/.test(before) || /[.!?]['"”’)]*\s+$/.test(before);
}

function capitalizeFirst(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
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
      let resolved = resolve(args as unknown as RegExpMatchArray, anchor);
      // Regardless of capture-group count, a String.replace callback's LAST
      // two arguments are always (offset, fullString) — reliable positional
      // access, unlike indexing from the front. Re-capitalize the
      // resolution's first letter when it replaces the start of a sentence
      // (e.g. "Last week's numbers..." must not become "the week
      // before..."'s numbers..." with a stray lowercase "the"); a no-op for
      // resolutions already starting with a digit or capital (dates, month
      // names), so this is safe to apply unconditionally.
      const offset = args[args.length - 2] as number;
      const fullString = args[args.length - 1] as string;
      if (isSentenceStart(fullString, offset)) resolved = capitalizeFirst(resolved);
      return resolved;
    });
    result = next;
  }
  return { text: result, grounded };
}
