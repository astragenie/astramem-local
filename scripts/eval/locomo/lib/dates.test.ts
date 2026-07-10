import { describe, it, expect } from 'vitest';
import { parseLocomoDateTime } from './dates.js';

describe('parseLocomoDateTime', () => {
  it('parses a real locomo10.json date string to UTC ISO-8601', () => {
    expect(parseLocomoDateTime('1:56 pm on 8 May, 2023')).toBe('2023-05-08T13:56:00.000Z');
  });

  it('handles midnight (12 am) and noon (12 pm) correctly', () => {
    expect(parseLocomoDateTime('12:09 am on 13 September, 2023')).toBe('2023-09-13T00:09:00.000Z');
    expect(parseLocomoDateTime('12:00 pm on 1 January, 2024')).toBe('2024-01-01T12:00:00.000Z');
  });

  it('handles single-digit hour and day', () => {
    expect(parseLocomoDateTime('9:35 am on 31 October, 2023')).toBe('2023-10-31T09:35:00.000Z');
  });

  it('is case-insensitive on am/pm', () => {
    expect(parseLocomoDateTime('1:56 PM on 8 May, 2023')).toBe('2023-05-08T13:56:00.000Z');
  });

  it('throws on an unparseable string', () => {
    expect(() => parseLocomoDateTime('2023/05/08 (Mon) 13:56')).toThrow(/unparseable LoCoMo date/);
  });

  it('throws on an unrecognized month name', () => {
    expect(() => parseLocomoDateTime('1:00 pm on 8 Smarch, 2023')).toThrow(/unrecognized month/);
  });
});
