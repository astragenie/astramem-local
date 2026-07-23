/**
 * Date-grounding retry (Graphiti pattern) — a second, narrow LLM call fired
 * ONLY on atoms whose text still carries an unresolved relative-date
 * expression after the main extraction prompt's own resolve-in-place
 * instruction (see prompts/extract.ts's "Date grounding" rule, PR #189/#191)
 * — that instruction is not reliably followed by every model in production
 * (~13% of temporal atoms measured still relative on the eval store). This
 * is a second chance at the SPECIFIC missing field, not a redesign — mirrors
 * graphiti's edge_operations.py:576-620 (a dedicated single-purpose call for
 * exactly the field that came back null/unresolved).
 *
 * A REGEX rewrite of this exact problem was tried and closed unmerged: PR
 * #257 fabricated dates across three adversarial rounds because deciding
 * whether a phrase like "last week" is a free-standing, session-relative
 * adverbial or a modifier bound inside a DIFFERENT noun's own timeline (“the
 * project's last week”, “her last week”) is a syntactic question a regex
 * lookaround cannot answer — see
 * docs/research/20260713-temporal-grounding-regex-postmortem.md. This module
 * still uses a regex (RELATIVE_DATE_DETECT_RE below) — but ONLY to decide
 * whether to ASK, never to answer. The actual resolution (or the decision to
 * leave the sentence alone) is made by the LLM, which reads the whole
 * sentence for its structure the way a regex lookaround cannot. Over-firing
 * the detector only costs one extra bounded call that may itself correctly
 * decline to rewrite; under-firing silently leaves a real relative phrase
 * ungrounded — the asymmetry is intentional.
 *
 * Placement: called from the PIPELINE (pipeline.ts, between stage 6 reduce
 * and stage 7 memory-normalize) — not from 05-extract.ts / the extraction
 * prompt (prompts/extract.ts). That file has two sibling PRs contending for
 * it as of 2026-07-13; this fix belongs to the pipeline, not the prompt.
 *
 * Contract, load-bearing:
 * - NEVER touches `atom.evidence` (the verbatim-quote/citation field) — only
 *   `atom.text`. Every code path below destructures/returns `text` alone.
 * - Failure of any kind (parse, network, timeout, thrown, malformed JSON) is
 *   a no-op: the atom's text is left EXACTLY as it was. Distill must never
 *   block or poison a job on this retry.
 * - Reuses the same LLMProvider the caller already has (extraction tier) —
 *   no new provider config surface, same posture as contradiction-judge.ts.
 * - No dollar-budget check (FEAT-482 lesson, see contradiction-judge.ts's own
 *   doc comment): codex-subscription always reports `usage.usd: 0`, so a
 *   dollar cap here could never trip. `maxCalls` bounds CALL COUNT instead —
 *   the real scarce resource for a metered subscription endpoint.
 *
 * GRANULARITY BUG (found in review, 2026-07-13, before this PR's first
 * merge attempt): an early version of the system prompt let the model
 * resolve "last week" all the way down to a specific day ("8 July 2023").
 * The source text never said WHICH day within that week — a specific day is
 * an invented fact, not a grounded one, even though it isn't the #257
 * class of fabrication (wrong noun/referent). Proof it was real: run twice
 * against the same anchor, the model returned two DIFFERENT days for the
 * identical input ("3 July 2023" vs "8 July 2023") — non-determinism on a
 * fixed anchor is itself the signal that the value wasn't derivable and the
 * model was guessing. Fixed by the GRANULARITY RULE in SYSTEM_PROMPT below:
 * a week/month/year-granularity source expression must resolve to a
 * week/month/year-granularity output (e.g. "the week before 15 July 2023"),
 * never collapsed to a specific day. Only genuinely day-determining source
 * expressions (yesterday/today/tomorrow, a named weekday, "N days ago")
 * resolve to a specific day. Regression coverage:
 * tests/distill/ground-dates.test.ts's granularity block, and
 * scripts/eval/date-grounding-retry-adversarial.mts's determinism check
 * (same input run 3+ times against the real provider, output must be
 * byte-identical every time).
 */

import { z } from 'zod';
import type { LLMProvider } from '../contracts/llm.js';
import type { ReducedAtom } from './stages/06-reduce.js';

/**
 * Stable marker embedded in the system prompt so a mock LLMProvider (tests,
 * ASTRA_MEMORY_MOCK_PROVIDERS=1) can route this call to a dedicated branch
 * before any extraction/json-mode detection heuristic misclassifies it —
 * mirrors CONTRADICTION_JUDGE_MARKER's role in contradiction-judge.ts.
 */
export const DATE_GROUNDING_RETRY_MARKER = 'astramem-date-grounding-retry-v1';

const SYSTEM_PROMPT = `${DATE_GROUNDING_RETRY_MARKER}. You resolve AT MOST one relative time expression inside a single sentence against a known session date — ONLY when that expression genuinely, unambiguously refers to the session's OWN timeline.

Respond with a single JSON object: {"resolved_text": "<the sentence>"}.

If — and only if — a phrase in the sentence is a free-standing reference to the session's own timeline (e.g. "I saw her last week" said BY the session, ABOUT the session's own recent past), replace that phrase per the GRANULARITY RULE below and return the rest of the sentence unchanged.

Many relative-looking phrases are NOT about the session's own timeline at all — they describe a DIFFERENT subject's own timeline, or the phrase is a modifier bound inside a noun phrase rather than a free adverbial:
- "the project's last week" describes the PROJECT's own final week, not the session's recent past.
- "her last week was overwhelming" — "her" is a different person's timeline; a possessive (noun's or pronoun's — his/her/its/their/my/your) immediately before the phrase is a strong signal the phrase is NOT session-relative.
- "the last week before the launch" — "before the launch" re-anchors the phrase to the launch, not to the session date.
- "the team's exhausting last month" — the phrase is an adjective-modified noun phrase describing the team's month, not an adverbial about when something happened.

Deciding this requires reading the WHOLE sentence and understanding what the phrase grammatically attaches to — not just pattern-matching the phrase in isolation.

If the expression is not clearly and unambiguously about the session's own timeline, or you are not confident, or the sentence has no relative time expression at all, return the sentence in "resolved_text" COMPLETELY UNCHANGED, character for character.

GRANULARITY RULE (critical — the resolved date must carry EXACTLY the same granularity as the source expression; never invent precision the source does not contain):
- "yesterday" / "today" / "tomorrow" determine a SPECIFIC DAY — resolve to "<D Month YYYY>" (1/-1/0 days from the session date).
- a NAMED weekday ("last Friday", "next Monday") or a bare weekday with no qualifier ("on Friday", meaning the nearest such day at or before the session date) also determines a SPECIFIC DAY — resolve to "<D Month YYYY>".
- "N days ago" determines a SPECIFIC DAY — resolve to "<D Month YYYY>", exactly N days before the session date.
- "last week" does NOT determine a specific day — resolve to "the week before <session date as D Month YYYY>". Example: session date 15 July 2023 -> "the week before 15 July 2023". NEVER resolve to a specific day like "8 July 2023" — the source does not say which day within that week, and naming one is a fabricated fact even if it happens to fall in the right week.
- "this week" -> "the week of <session date as D Month YYYY>". "next week" -> "the week after <session date as D Month YYYY>".
- "last weekend" -> "the weekend before <session date as D Month YYYY>". "next weekend" -> "the weekend after <session date as D Month YYYY>".
- "N weeks ago" / "a few weeks ago" / "several weeks ago" do NOT determine a specific day — resolve to "N weeks before <session date as D Month YYYY>" (or "a few weeks before ...", matching the source's own quantifier).
- "last month" does NOT determine a specific day — resolve to "<Month> <YYYY>" of the calendar month immediately before the session date's month (no day). "this month" -> the session date's own "<Month> <YYYY>" (no day). "next month" -> the calendar month immediately after (no day).
- "N months ago" / "a few months ago" do NOT determine a specific day — resolve to "<Month> <YYYY>" of the calendar month N months before the session date's month (no day).
- "last year" / "this year" / "next year" / "N years ago" do NOT determine a month or day — resolve to the bare year only, e.g. "2022" (never "March 2022", never a specific day).
- "earlier this week/month/year" matches the granularity of whichever unit is named, using the templates above.
- "recently" or any other marker with no derivable granularity at all — leave the sentence UNCHANGED. A distance-free word has no anchor-relative arithmetic that recovers it without guessing.

The overriding principle: a WEEK/MONTH/YEAR-granularity source expression must resolve to a WEEK/MONTH/YEAR-granularity output — never collapsed to a specific day. An honest, less-precise-but-true phrase ("the week before 15 July 2023") is always better than a confident, more-precise-but-possibly-wrong one ("8 July 2023") — the source never said which day. Never guess. Never invent precision beyond what the session date and the expression directly imply.`;

const RetryResponseSchema = z.object({ resolved_text: z.string().min(1) });

/** Month names for the bare "back in <month>" / "in early|late <month>" detector below. */
const MONTH_NAMES =
  'january|february|march|april|may|june|july|august|september|october|november|december';

/**
 * Narrow, DETECTION-ONLY regex — decides whether an atom is a CANDIDATE for
 * the retry call. Never used to rewrite text (that is exactly the mistake PR
 * #257 made — see module doc comment). Word-boundaried throughout so this
 * doesn't fire on unrelated prose ("last chance", "at last", "recent commit"
 * — note "recent" alone is deliberately NOT matched, only "recently", since
 * "recent" mostly modifies a noun rather than acting as a time adverbial).
 * Also does not fire on already-absolute month references ("in June 2023") —
 * the bare-month alternative below excludes a trailing 4-digit year via a
 * negative lookahead, since that phrase needs no grounding at all.
 */
const RELATIVE_DATE_DETECT_RE = new RegExp(
  [
    '\\b(?:yesterday|tomorrow|today|tonight)\\b',
    '\\b(?:last|this|next)\\s+(?:week|weekend|month|year)\\b',
    '\\b(?:last|next)\\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\\b',
    // Any single quantifier word before "day(s)/week(s)/month(s)/year(s) ago"
    // or "...back" — digits ("3 years ago") and spelled-out numbers/quantifiers
    // ("three years ago", "a few weeks ago", "a couple of months back",
    // "several months ago") all match via the unconstrained single-token
    // lookback (the token directly before the unit need not be the leading
    // "a"/number itself — "a couple of weeks ago" matches on "of weeks ago").
    // A false positive here only costs one extra bounded LLM call.
    '\\b\\S+\\s+(?:day|week|month|year)s?\\s+(?:ago|back)\\b',
    '\\bearlier\\s+(?:today|(?:this|that)\\s+(?:week|month|year))\\b',
    '\\b(?:recently|lately|the other day)\\b',
    // Seasons are session-relative the same way weekday/month names are;
    // "over the summer/winter/weekend/holidays" is the non-last/this/next form.
    '\\b(?:last|this|next)\\s+(?:summer|winter|spring|fall|autumn)\\b',
    '\\b(?:over|during)\\s+the\\s+(?:summer|winter|spring|fall|autumn|weekend|holidays?)\\b',
    `\\b(?:back\\s+in|in\\s+(?:early|late))\\s+(?:${MONTH_NAMES})\\b(?!\\s*,?\\s*\\d{4})`,
    '\\bthis\\s+(?:morning|afternoon|evening)\\b',
    '\\blast\\s+night\\b',
  ].join('|'),
  'i',
);

/** Exported so a caller (or a test) can check candidacy without spending a call. */
export function hasUnresolvedRelativeDate(text: string): boolean {
  return RELATIVE_DATE_DETECT_RE.test(text);
}

export interface GroundDatesResult {
  atoms: ReducedAtom[];
  /** Atoms whose text matched the detector AND had a real session anchor —
   * i.e. the retry call was actually fired for them. */
  fired: number;
  /** Subset of `fired` whose text the LLM actually changed. `fired -
   * resolved` is NOT a failure by itself — it includes the LLM correctly
   * declining to rewrite a phrase that wasn't genuinely session-relative,
   * as well as parse/network fallbacks (see `errors`). */
  resolved: number;
  /** Subset of `fired` that fell back to unchanged text because the call
   * threw or the response failed to parse — a strict subset of `fired -
   * resolved`, kept separate so a caller/test can distinguish "the model
   * declined on purpose" from "the retry mechanism itself broke". */
  errors: number;
  /** Total atoms considered — the denominator for a fire-rate measurement. */
  totalAtoms: number;
  /** True iff `maxWallClockMs` tripped before every candidate atom got a
   *  call — distinguishes "ran out of time" from "ran out of candidates" the
   *  same way consolidate.ts's `contradictionWallClockCapReached` does. */
  wallClockCapReached: boolean;
}

export interface GroundDatesOptions {
  /** Safety valve bounding total LLM calls this invocation can make,
   * independent of how many atoms match the detector. This runs against one
   * session's already-reduced atoms (typically single-digit to low tens),
   * so blowup risk is far lower than the pairwise contradiction judge — this
   * is cheap insurance against a pathological transcript, not a routine
   * limiter. Mirrors consolidate.ts's maxPerRun call-count cap (FEAT-482). */
  maxCalls?: number;
  /**
   * FEAT-482 fold (worker-starvation wave): wall-clock cap (ms) on the
   * ENTIRE grounding sweep within one `groundAtomDates()` invocation —
   * mirrors consolidate.ts's dual-cap shape (contradiction-judge.ts /
   * dup-judge.ts's `maxPerRun` + `maxWallClockMs`). `maxCalls` alone bounds
   * CALL COUNT, not TIME: a slow or rate-limited provider can still stall a
   * distill job well past what `maxCalls` alone protects against if each
   * call is slow enough — the exact FEAT-482 incident shape (~245 calls at
   * ~13/min against a throttled endpoint, 10+ minutes, not a count
   * problem). Once exceeded, remaining candidate atoms fall through
   * UNCHANGED — same fail-open contract as the `maxCalls` cap, never a
   * partial/guessed resolution. Default 300_000 (5 min), matching
   * contradictionDetection/dupJudge/atomTriage/gatekeeper's shared default.
   */
  maxWallClockMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_MAX_CALLS = 50;
const DEFAULT_MAX_WALL_CLOCK_MS = 300_000;

/**
 * Runs the date-grounding retry over a reduced atom list. `sessionDateIso`
 * absent (no real capture-date anchor available for this session — legacy
 * v0.0 envelopes, direct /remember calls) is a total no-op: every atom
 * passes through unchanged, byte-identical to the pre-retry pipeline, since
 * there is nothing to ground against.
 */
export async function groundAtomDates(
  atoms: ReducedAtom[],
  sessionDateIso: string | undefined,
  llm: LLMProvider,
  opts: GroundDatesOptions = {},
): Promise<GroundDatesResult> {
  const log = opts.log ?? ((message: string) => console.warn(message));
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  const maxWallClockMs = opts.maxWallClockMs ?? DEFAULT_MAX_WALL_CLOCK_MS;

  if (!sessionDateIso) {
    return { atoms, fired: 0, resolved: 0, errors: 0, totalAtoms: atoms.length, wallClockCapReached: false };
  }

  const startedAt = Date.now();
  let fired = 0;
  let resolved = 0;
  let errors = 0;
  let cappedWarned = false;
  let wallClockCapReached = false;
  let wallClockWarned = false;
  const out: ReducedAtom[] = [];

  for (const atom of atoms) {
    const isCandidate = hasUnresolvedRelativeDate(atom.text);

    if (fired >= maxCalls) {
      // Visibility only — the cap itself is unchanged; this just makes a
      // silent truncation (an atom that DID match but never got a call)
      // observable. Logged once per invocation, not once per skipped atom,
      // to avoid spamming the same fact for a large batch.
      if (isCandidate && !cappedWarned) {
        cappedWarned = true;
        log(`[date-grounding-retry] maxCalls (${maxCalls}) reached — remaining matching atoms left ungrounded`);
      }
      out.push(atom);
      continue;
    }

    // Wall-clock cap: checked BEFORE each call, mirroring
    // DupJudgeRunTracker/AtomTriageRunTracker's shouldStop() shape — bounds
    // worst-case duration against a slow/rate-limited provider, which
    // maxCalls alone cannot (FEAT-482 lesson).
    const elapsed = Date.now() - startedAt;
    if (elapsed >= maxWallClockMs) {
      wallClockCapReached = true;
      if (isCandidate && !wallClockWarned) {
        wallClockWarned = true;
        log(`[date-grounding-retry] maxWallClockMs (${maxWallClockMs}ms) reached after ${elapsed}ms — remaining matching atoms left ungrounded`);
      }
      out.push(atom);
      continue;
    }

    if (!isCandidate) {
      out.push(atom);
      continue;
    }

    fired++;
    const outcome = await resolveOne(atom.text, sessionDateIso, llm, log);
    if (outcome.errored) errors++;

    const groundedText = outcome.text.trim();
    if (groundedText.length > 0 && groundedText !== atom.text.trim()) {
      resolved++;
      // Only `text` is replaced — every other field (including `evidence`)
      // passes through via the spread, untouched.
      out.push({ ...atom, text: groundedText });
    } else {
      out.push(atom);
    }
  }

  return { atoms: out, fired, resolved, errors, totalAtoms: atoms.length, wallClockCapReached };
}

async function resolveOne(
  text: string,
  sessionDateIso: string,
  llm: LLMProvider,
  log: (message: string) => void,
): Promise<{ text: string; errored: boolean }> {
  try {
    const result = await llm.chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Session date: ${sessionDateIso}\n\nSentence: ${text}\n\nRespond with JSON.` },
      ],
      { temperature: 0, json: true },
    );
    const parsed = RetryResponseSchema.safeParse(JSON.parse(result.text));
    if (!parsed.success) {
      log(`[date-grounding-retry] unparsable response — leaving text unchanged: ${parsed.error.message}`);
      return { text, errored: true };
    }
    return { text: parsed.data.resolved_text, errored: false };
  } catch (err) {
    log(`[date-grounding-retry] call failed — leaving text unchanged: ${err instanceof Error ? err.message : String(err)}`);
    return { text, errored: true };
  }
}
