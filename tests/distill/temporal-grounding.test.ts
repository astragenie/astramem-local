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
      const r = groundRelativeDates('She met them last Friday and next Friday too.', ANCHOR);
      expect(r.text).toBe('She met them 14 July 2023 and 21 July 2023 too.');
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
});
