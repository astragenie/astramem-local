import { describe, it, expect } from 'vitest';
import { groundRelativeDates } from '../../src/distill/temporal-grounding.js';

// Anchor used across most cases below: 2023-07-15 is a Saturday.
const ANCHOR = '2023-07-15';

describe('groundRelativeDates', () => {
  describe('resolves known relative expressions against an anchor', () => {
    it('yesterday -> the day before the anchor', () => {
      const r = groundRelativeDates('Caroline attended a support group yesterday.', ANCHOR);
      expect(r.grounded).toBe(true);
      expect(r.text).toBe('Caroline attended a support group 14 July 2023.');
    });

    it('today -> the anchor day itself', () => {
      const r = groundRelativeDates('Melanie went to the museum today.', ANCHOR);
      expect(r.text).toBe('Melanie went to the museum 15 July 2023.');
    });

    it('tomorrow -> the day after the anchor', () => {
      const r = groundRelativeDates('The meeting is tomorrow.', ANCHOR);
      expect(r.text).toBe('The meeting is 16 July 2023.');
    });

    it('last year -> the numeral year before the anchor year', () => {
      const r = groundRelativeDates('Melanie painted a sunrise last year.', ANCHOR);
      expect(r.text).toBe('Melanie painted a sunrise 2022.');
    });

    it('this year / next year resolve to the correct numeral year', () => {
      expect(groundRelativeDates('It happens this year.', ANCHOR).text).toBe('It happens 2023.');
      expect(groundRelativeDates('It happens next year.', ANCHOR).text).toBe('It happens 2024.');
    });

    it('last month / this month / next month resolve to "Month YYYY"', () => {
      expect(groundRelativeDates('She signed up last month.', ANCHOR).text).toBe('She signed up June 2023.');
      expect(groundRelativeDates('It is happening this month.', ANCHOR).text).toBe('It is happening July 2023.');
      expect(groundRelativeDates('It is planned for next month.', ANCHOR).text).toBe('It is planned for August 2023.');
    });

    it('last week / this week resolve to a reference-point phrase naming the anchor, not a guessed day', () => {
      expect(groundRelativeDates('Caroline had a picnic last week.', ANCHOR).text)
        .toBe('Caroline had a picnic the week before 15 July 2023.');
      expect(groundRelativeDates('Caroline applied this week.', ANCHOR).text)
        .toBe('Caroline applied the week of 15 July 2023.');
    });

    it('last weekend / next weekend resolve to a reference-point phrase naming the anchor', () => {
      expect(groundRelativeDates('Caroline went biking last weekend.', ANCHOR).text)
        .toBe('Caroline went biking the weekend before 15 July 2023.');
      expect(groundRelativeDates('The trip is next weekend.', ANCHOR).text)
        .toBe('The trip is the weekend after 15 July 2023.');
    });

    it('a week-phrase built off a month-end anchor formats the anchor date correctly (no addMonthsUtc involved)', () => {
      // Week-granularity patterns format the ANCHOR itself, not an
      // arithmetic result -- confirms they're unaffected by the
      // addMonthsUtc month-overflow class of bug even on a boundary date.
      expect(groundRelativeDates('It happened last week.', '2023-07-31').text)
        .toBe('It happened the week before 31 July 2023.');
      expect(groundRelativeDates('It happens this week.', '2023-01-31').text)
        .toBe('It happens the week of 31 January 2023.');
    });

    it('"last weekend" is not mangled by the "last week" pattern (word-boundary discipline)', () => {
      const r = groundRelativeDates('Caroline went biking last weekend, it was fun.', ANCHOR);
      expect(r.text).toBe('Caroline went biking the weekend before 15 July 2023, it was fun.');
      expect(r.text).not.toContain('week before 15 July 2023end');
    });

    it('does NOT resolve "this weekend" or "next week" — not part of the measured, approved scope', () => {
      const r = groundRelativeDates('The plan is for this weekend, or maybe next week.', ANCHOR);
      expect(r.grounded).toBe(false);
      expect(r.text).toBe('The plan is for this weekend, or maybe next week.');
    });

    it('last <weekday> resolves to the most recent prior occurrence, never the anchor day itself', () => {
      // ANCHOR (2023-07-15) is itself a Saturday — "last Saturday" must mean
      // 7 days ago, not today.
      const r = groundRelativeDates('Caroline went to the workshop last Saturday.', ANCHOR);
      expect(r.text).toBe('Caroline went to the workshop 8 July 2023.');
    });

    it('last <weekday> for a weekday earlier in the same week', () => {
      // Friday before a Saturday anchor is the day before.
      const r = groundRelativeDates('They met last Friday.', ANCHOR);
      expect(r.text).toBe('They met 14 July 2023.');
    });

    it('next <weekday> resolves to the next occurrence, never the anchor day itself', () => {
      const r = groundRelativeDates('The conference is next Saturday.', ANCHOR);
      expect(r.text).toBe('The conference is 22 July 2023.');
    });

    it('is case-insensitive', () => {
      const r = groundRelativeDates('Yesterday was rough.', ANCHOR);
      expect(r.text).toBe('14 July 2023 was rough.');
    });

    it('resolves multiple distinct expressions in one atom', () => {
      const r = groundRelativeDates(
        'Caroline signed up yesterday, and mentioned the event happens next month.',
        ANCHOR,
      );
      expect(r.grounded).toBe(true);
      expect(r.text).toBe('Caroline signed up 14 July 2023, and mentioned the event happens August 2023.');
    });

    it('bare "on <weekday>" (no last/next prefix) resolves to the nearest occurrence at or before the anchor', () => {
      const r = groundRelativeDates(
        'Melanie took her kids to a pottery workshop on Friday, where they made pots.',
        ANCHOR,
      );
      expect(r.text).toBe('Melanie took her kids to a pottery workshop on 14 July 2023, where they made pots.');
    });

    it('bare "on <weekday>" includes the anchor day itself when the anchor IS that weekday', () => {
      // ANCHOR (2023-07-15) is a Saturday.
      const r = groundRelativeDates('The show was on Saturday.', ANCHOR);
      expect(r.text).toBe('The show was on 15 July 2023.');
    });

    it('a bare weekday does not get double-resolved when "last <weekday>" already matched it', () => {
      const r = groundRelativeDates('She met them last Friday and next Friday.', ANCHOR);
      expect(r.text).toBe('She met them 14 July 2023 and 21 July 2023.');
    });
  });

  describe('does NOT hallucinate a date it was not given', () => {
    it('leaves relative phrasing untouched when sessionDateIso is undefined', () => {
      const r = groundRelativeDates('Caroline attended a support group yesterday.', undefined);
      expect(r.grounded).toBe(false);
      expect(r.text).toBe('Caroline attended a support group yesterday.');
    });

    it('leaves relative phrasing untouched when sessionDateIso is malformed', () => {
      const r = groundRelativeDates('It happened last month.', 'not-a-date');
      expect(r.grounded).toBe(false);
      expect(r.text).toBe('It happened last month.');
    });

    it('leaves relative phrasing untouched when sessionDateIso is an empty string', () => {
      const r = groundRelativeDates('It happened last month.', '');
      expect(r.grounded).toBe(false);
      expect(r.text).toBe('It happened last month.');
    });

    it('is a no-op on text with no relative-date expression, even with a valid anchor', () => {
      const r = groundRelativeDates('Caroline is a transgender woman who loves painting.', ANCHOR);
      expect(r.grounded).toBe(false);
      expect(r.text).toBe('Caroline is a transgender woman who loves painting.');
    });

    it('does not touch unrelated words that merely contain a pattern as a substring', () => {
      // "yesteryear" must not be mangled by the "year" family of patterns,
      // and "todayish" must not trigger \btoday\b (word boundary discipline).
      const r = groundRelativeDates('She used an old-fashioned, yesteryear kind of phrase.', ANCHOR);
      expect(r.grounded).toBe(false);
      expect(r.text).toBe('She used an old-fashioned, yesteryear kind of phrase.');
    });
  });

  describe('month-end anchors (review finding, 2026-07-13) — the whole rest of this suite only ever uses the 15th', () => {
    // Regression coverage for a real bug: `setUTCMonth` on a Date still
    // carrying the anchor's day-of-month overflows FORWARD when that day
    // doesn't exist in the target month (e.g. Aug 31 doesn't exist -> rolls
    // into September). Every case below anchors on the 29th/30th/31st
    // specifically because the 15th (used everywhere else in this file) can
    // NEVER trigger the bug — that blind spot is exactly why 307 previously-
    // green tests didn't catch it.
    it('last month from the 31st of a 31-day month does not collapse into the same month', () => {
      const r = groundRelativeDates('It happened last month.', '2023-07-31');
      expect(r.text).toBe('It happened June 2023.');
    });

    it('next month from the 31st does not skip a month', () => {
      const r = groundRelativeDates('It happens next month.', '2023-07-31');
      expect(r.text).toBe('It happens August 2023.');
    });

    it('next month from March 31st does not skip April entirely (April has 30 days)', () => {
      const r = groundRelativeDates('It happens next month.', '2023-03-31');
      expect(r.text).toBe('It happens April 2023.');
    });

    it('next month from January 31st does not skip February (28/29 days)', () => {
      const r = groundRelativeDates('It happens next month.', '2023-01-31');
      expect(r.text).toBe('It happens February 2023.');
    });

    it('last month from January 31st crosses the year boundary to December', () => {
      const r = groundRelativeDates('It happened last month.', '2023-01-31');
      expect(r.text).toBe('It happened December 2022.');
    });

    it('year arithmetic from a Feb 29 leap-day anchor still reports the correct year', () => {
      // Only getUTCFullYear() is ever read for year resolution, so even
      // though Date normalizes Feb 29 + 1 non-leap year into March 1, the
      // YEAR value itself is unaffected — verified explicitly, not assumed.
      expect(groundRelativeDates('It happens next year.', '2024-02-29').text).toBe('It happens 2025.');
      expect(groundRelativeDates('It happened last year.', '2024-02-29').text).toBe('It happened 2023.');
      expect(groundRelativeDates('It happens this year.', '2024-02-29').text).toBe('It happens 2024.');
    });
  });

  describe('does NOT fabricate a date when the phrase modifies a DIFFERENT referent — allowlist (round 2 validation finding, 2026-07-13)', () => {
    // Round 1: a behavior validation pass against 3ebf40b reproduced real
    // date FABRICATION: "the last week of the project" resolved to "the the
    // week before 15 July 2023 of the project" — a confident, precisely-
    // formatted, and completely FALSE claim. Fixed with a blocklist (refuse
    // when followed by " of <noun>").
    //
    // Round 2: the blocklist was insufficient BY CONSTRUCTION and a second
    // validation pass proved it in under five minutes with FOUR more
    // fabrications the "of" guard never touched — "before"/"for" reach the
    // identical construction "of" was guarding against, and a Saxon
    // genitive ("<referent>'s last <unit>'s...") is the exact syntactic
    // mirror of "of" spelled differently. See module header ("ALLOWLIST,
    // not blocklist") for the full history and the two independent guards
    // (SAFE_FOLLOWING_CONTEXT, NOT_PRECEDED_BY_POSSESSIVE) that replaced the
    // blocklist. Every case below is a verbatim repro from one of the two
    // validation reports and MUST resolve to the input UNCHANGED.
    const NON_SESSION_RELATIVE_CASES = [
      // round 1 -- "of <noun>"
      'It was last week of school when everything changed.',
      'That was during last week of the semester.',
      'Melanie described it as the toughest last week of training.',
      'They finished last week of rehearsals before opening night.',
      'The championship final falls on next weekend of the tournament.',
      'Caroline described the last week of the project as extremely stressful.',
      'This was the last month of the semester.',
      'It happened during the last year of the war.',
      'They always meet on the last Friday of the month.',
      'She dreaded the last Friday of training camp.',
      // round 2 -- "before"/"for" reach the identical fabrication "of" was
      // guarding against; neither is a genitive, so these are proof the
      // guard cannot be a preposition ENUMERATION at all, not just proof
      // "of" needed company.
      'The last week before the launch was chaos.',
      'The last month for the project was rushed.',
      // round 2 -- Saxon genitive: "<referent>'s last <unit>'s..." is the
      // exact syntactic mirror of "the last <unit> of <referent>."
      "The project's last week's numbers were the worst on record.",
      "It was the war's last year's casualty count that shocked everyone.",
      // Constructed independently while building the round-2 fix (not from
      // either validation report) to prove the two guards are NOT
      // redundant: a preceding possessive with an otherwise-safe-looking
      // FOLLOWING context (" was chaos." matches the copula allowlist) —
      // the following-side guard ALONE would still fabricate here. Both
      // guards are independently load-bearing; removing either one under
      // the assumption the other covers it would silently reopen this case.
      "The project's last week was chaos.",
    ];

    it.each(NON_SESSION_RELATIVE_CASES)('leaves %j completely unresolved', (input) => {
      const r = groundRelativeDates(input, ANCHOR);
      expect(r.grounded).toBe(false);
      expect(r.text).toBe(input);
    });

    // The allowlist is narrow but not a blanket refusal near any
    // punctuation or nested clause — these, also verbatim from the
    // validation reports' fixtures, are genuinely session-relative and MUST
    // still resolve normally. Pinned alongside the unresolved cases above
    // so the allowlist's boundary is tested from both sides, not just the
    // side that must refuse.
    it('still resolves "next weekend" followed by punctuation (no re-anchoring continuation)', () => {
      const r = groundRelativeDates('This coming next weekend is the trip.', ANCHOR);
      expect(r.text).toBe('This coming the weekend after 15 July 2023 is the trip.');
    });

    it('still resolves "last month" when followed by a comma, not "of" — and leaves the unsupported "next week" inside the same string alone', () => {
      const r = groundRelativeDates(
        "Caroline mentioned that in her email last month, she wrote: 'I'll see you next week.'",
        ANCHOR,
      );
      expect(r.text).toBe("Caroline mentioned that in her email June 2023, she wrote: 'I'll see you next week.'");
    });

    it('still resolves "last year" and "next month" in the same sentence when neither is followed by "of"', () => {
      const r = groundRelativeDates(
        'The article, published last year, said the district plans to open next month.',
        ANCHOR,
      );
      expect(r.text).toBe('The article, published 2022, said the district plans to open August 2023.');
    });

    it('does not fabricate a date through the full extractChunk-style flow either (regression pin, not just the direct probe)', () => {
      // Mirrors the validation report's pipeline-level repro shape directly
      // against groundRelativeDates, since that's the exact function
      // extractChunk calls per atom (see 05-extract.ts's groundAtomDates).
      const r = groundRelativeDates(
        'Caroline described the last week of the project as extremely stressful.',
        ANCHOR,
      );
      expect(r.text).not.toContain('the the');
      expect(r.text).toBe('Caroline described the last week of the project as extremely stressful.');
    });

    // Honest, accepted coverage loss (WS1 handoff notes) — NOT a bug. Two of
    // the 22 real LoCoMo bucket-(b) cases this module was originally
    // measured against use "last week" followed by a preposition
    // (with/about) that ISN'T on the safe-following allowlist. "with"/"about"
    // were deliberately NOT added: "with"/"about" can themselves introduce a
    // re-anchoring noun phrase just like "of"/"before"/"for" ("the last week
    // WITH the old team" describes the team's last week, not the session's) —
    // adding them back to chase these two cases would reopen exactly the
    // class of vulnerability round 2 just closed. Coverage dropped from
    // 20/22 to 18/22 as a direct, deliberate, and reported consequence.
    it('accepted coverage loss: "last week" followed by "with" no longer resolves (real bucket-(b) case #21)', () => {
      const r = groundRelativeDates(
        'Caroline had a picnic last week with her friends and family, which was a meaningful moment.',
        '2023-07-06',
      );
      expect(r.grounded).toBe(false);
    });

    it('accepted coverage loss: "last week" followed by "about" no longer resolves (real bucket-(b) case #8)', () => {
      const r = groundRelativeDates(
        'Caroline gave a talk at her school last week about her transgender journey.',
        '2023-06-08',
      );
      expect(r.grounded).toBe(false);
    });
  });

  describe('guards a following possessive "\'s" too — reversed from round 1, forced by round 2 validation (2026-07-13)', () => {
    // Round 1 shipped a deliberate exception: a trailing possessive
    // ("last week's numbers were bad") was reasoned to be safe because it
    // doesn't change what the phrase refers to. Round 2 FALSIFIED that
    // reasoning: "The project's last week's numbers were the worst on
    // record" resolved to "...the week before 15 July 2023's numbers..." —
    // a fabrication, because the SAME "'s" construction, once something
    // else (another noun's possessive) precedes it, IS the re-anchoring
    // vector. Rather than special-case "'s is safe only when nothing
    // precedes it" — a blocklist-shaped carve-out that just reopens the
    // same class of gap under a different name — the simpler, safer rule
    // now is: a following "'s" is never in the allowlist, full stop. This
    // resolves fewer phrases than round 1 did. That is the intended,
    // reported tradeoff — see module header, "cost asymmetry."
    it('"last week\'s X" no longer resolves, even completely standalone with no preceding possessive', () => {
      const r = groundRelativeDates("Last week's numbers were bad.", ANCHOR);
      expect(r.grounded).toBe(false);
      expect(r.text).toBe("Last week's numbers were bad.");
    });

    it('"next weekend\'s X" no longer resolves', () => {
      const r = groundRelativeDates("We are targeting next weekend's release.", ANCHOR);
      expect(r.grounded).toBe(false);
      expect(r.text).toBe("We are targeting next weekend's release.");
    });
  });

  describe('sentence-initial capitalization is preserved (validation finding, 2026-07-13)', () => {
    // The week/weekend resolutions are the only ones whose replacement text
    // starts with a lowercase word ("the week before...") — every other
    // resolution starts with a digit or a proper-noun month name, which
    // never needs re-capitalizing. Left unhandled, a sentence-initial "Last
    // week was rough..." would become "the week before...was rough...",
    // silently breaking capitalization on real atom text. Uses "Last week
    // was rough." (not "Last week's numbers...") as the test vehicle since
    // round 2 made the 's-continuation case stop resolving at all (see the
    // possessive-guard describe block above) — "was" is on the safe-
    // following copula allowlist, so this case still resolves and still
    // exercises the capitalization fix.
    it('capitalizes the resolution at the true start of the string', () => {
      const r = groundRelativeDates('Last week was rough.', ANCHOR);
      expect(r.grounded).toBe(true);
      expect(r.text).toBe('The week before 15 July 2023 was rough.');
    });

    it('capitalizes the resolution after a sentence boundary mid-string', () => {
      const r = groundRelativeDates('Last month was busy. Next weekend is the trip.', ANCHOR);
      expect(r.text).toBe('June 2023 was busy. The weekend after 15 July 2023 is the trip.');
    });

    it('does not capitalize (and does not need to) a resolution that is not sentence-initial', () => {
      const r = groundRelativeDates('She said the picnic was last week.', ANCHOR);
      expect(r.text).toBe('She said the picnic was the week before 15 July 2023.');
    });
  });

  describe('quoted/reported speech resolves against the session anchor — known, documented limitation, pinned not silently accepted', () => {
    // No discourse model exists in a pure regex pass (module header, "Known
    // limitation... quoted or reported speech"). In an ordinary same-session
    // transcript this is usually still correct — the quote was uttered close
    // to the session's own capture time — so it resolves normally rather
    // than being guarded. Pinned so the tradeoff is visible and intentional,
    // not an accidental gap nobody noticed.
    it('resolves a relative phrase inside a same-session quotation', () => {
      const r = groundRelativeDates('Caroline said "I saw her last week" during the call.', ANCHOR);
      expect(r.text).toBe('Caroline said "I saw her the week before 15 July 2023" during the call.');
    });
  });

  describe('"recently" is never resolved — permanent exclusion, pinned (review request, 2026-07-13)', () => {
    // The module header calls this exclusion a standing principle, but
    // nothing previously pinned it with a dedicated test — a future change
    // could silently add a "recently" pattern without any test failing.
    it('leaves "recently" completely untouched even with a valid anchor', () => {
      const r = groundRelativeDates('Caroline started therapy recently.', ANCHOR);
      expect(r.grounded).toBe(false);
      expect(r.text).toBe('Caroline started therapy recently.');
    });

    it('leaves "recently" untouched even alongside other resolvable expressions in the same atom', () => {
      const r = groundRelativeDates('She started therapy recently and saw a specialist yesterday.', ANCHOR);
      expect(r.text).toBe('She started therapy recently and saw a specialist 14 July 2023.');
    });
  });
});
