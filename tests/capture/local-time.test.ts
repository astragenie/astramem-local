// 2026-07-13 timezone-offset bugfix — see src/capture/local-time.ts's module
// doc for the full root-cause story: `new Date().toISOString()` always
// rendered the UTC calendar date, discarding the local capture offset, which
// made every downstream "yesterday"-style resolution in stage-5 extraction
// (src/distill/pipeline.ts's sessionDateIso) one day off for any evening
// session west of UTC.
//
// These tests manipulate `process.env.TZ` at runtime — confirmed (see PR
// description) that Node's local Date getters (getHours/getTimezoneOffset/
// etc.) respect a TZ change immediately, with no process restart needed.

import { describe, it, expect, afterEach } from 'vitest';
import { localIsoString } from '../../src/capture/local-time.js';

const ORIGINAL_TZ = process.env.TZ;

describe('localIsoString', () => {
  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  it('AC-4a: renders the LOCAL calendar date for an evening UTC-7 (PDT) capture, not the UTC next-day date', () => {
    process.env.TZ = 'America/Los_Angeles';
    // 21:00 local on 2026-07-13 — 04:00 UTC on 2026-07-14 (the bug: slicing
    // .toISOString() here yields "2026-07-14", the user's tomorrow).
    const captureTime = new Date(2026, 6, 13, 21, 0, 0, 0);
    expect(captureTime.toISOString()).toBe('2026-07-14T04:00:00.000Z');

    const result = localIsoString(captureTime);

    expect(result).toBe('2026-07-13T21:00:00.000-07:00');
    expect(result.slice(0, 10)).toBe('2026-07-13'); // the correct local date
  });

  it('AC-4c: a UTC user (offset 0) gets a Z-suffixed string, byte-identical to toISOString()', () => {
    process.env.TZ = 'UTC';
    const captureTime = new Date(Date.UTC(2026, 6, 13, 21, 0, 0, 0));

    expect(localIsoString(captureTime)).toBe(captureTime.toISOString());
    expect(localIsoString(captureTime)).toBe('2026-07-13T21:00:00.000Z');
  });

  it('renders a positive offset (UTC+5:30) correctly', () => {
    process.env.TZ = 'Asia/Kolkata';
    const captureTime = new Date(2026, 6, 13, 21, 0, 0, 0);

    expect(localIsoString(captureTime)).toBe('2026-07-13T21:00:00.000+05:30');
  });

  it('round-trips to the identical epoch a Z-suffixed string for the same instant would (backward compat, AC-1)', () => {
    process.env.TZ = 'America/Los_Angeles';
    const captureTime = new Date(2026, 6, 13, 21, 0, 0, 0);

    const offsetBearing = localIsoString(captureTime);
    expect(new Date(offsetBearing).getTime()).toBe(captureTime.getTime());
  });

  it('defaults to `new Date()` when called with no argument', () => {
    const result = localIsoString();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/);
  });
});
