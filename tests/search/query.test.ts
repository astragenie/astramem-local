import { describe, it, expect } from 'vitest';
import { parseQuery } from '../../src/search/query.js';

describe('parseQuery', () => {
  it('returns bare query with no filters', () => {
    const result = parseQuery('sqlite full text search');
    expect(result.q).toBe('sqlite full text search');
    expect(result.filters).toEqual({});
  });

  it('extracts type: filter', () => {
    const result = parseQuery('type:decision use sqlite');
    expect(result.q).toBe('use sqlite');
    expect(result.filters.type).toEqual(['decision']);
  });

  it('extracts repo: filter', () => {
    const result = parseQuery('repo:astramemory-local sqlite');
    expect(result.q).toBe('sqlite');
    expect(result.filters.repo).toBe('astramemory-local');
  });

  it('extracts project: filter', () => {
    const result = parseQuery('project:wave2 some query');
    expect(result.q).toBe('some query');
    expect(result.filters.project).toBe('wave2');
  });

  it('since:7d → epoch ms approximately 7 days ago', () => {
    const before = Date.now();
    const result = parseQuery('since:7d hello world');
    const after = Date.now();
    expect(result.q).toBe('hello world');
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(result.filters.since).toBeGreaterThanOrEqual(before - sevenDaysMs - 1000);
    expect(result.filters.since).toBeLessThanOrEqual(after - sevenDaysMs + 1000);
  });

  it('since:24h → epoch ms approximately 24 hours ago', () => {
    const before = Date.now();
    const result = parseQuery('since:24h sqlite');
    const after = Date.now();
    expect(result.q).toBe('sqlite');
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    expect(result.filters.since).toBeGreaterThanOrEqual(before - twentyFourHoursMs - 1000);
    expect(result.filters.since).toBeLessThanOrEqual(after - twentyFourHoursMs + 1000);
  });

  it('since:1h → epoch ms approximately 1 hour ago', () => {
    const before = Date.now();
    const result = parseQuery('since:1h query');
    const after = Date.now();
    expect(result.q).toBe('query');
    const oneHourMs = 60 * 60 * 1000;
    expect(result.filters.since).toBeGreaterThanOrEqual(before - oneHourMs - 1000);
    expect(result.filters.since).toBeLessThanOrEqual(after - oneHourMs + 1000);
  });

  it('multiple filters in one query', () => {
    const result = parseQuery('type:fact repo:myrepo since:7d what did we decide');
    expect(result.q).toBe('what did we decide');
    expect(result.filters.type).toEqual(['fact']);
    expect(result.filters.repo).toBe('myrepo');
    expect(result.filters.since).toBeDefined();
  });

  it('unknown filter prefix is ignored, included in q as-is', () => {
    // bad:value should be treated as ignored per spec — we pass it through as plain query text
    const result = parseQuery('bad:value query terms');
    expect(result.q).toContain('query terms');
    // bad:value is an unknown filter — not applied to filters object
    expect(result.filters.type).toBeUndefined();
    expect(result.filters.repo).toBeUndefined();
  });

  it('empty string → empty q, no filters', () => {
    const result = parseQuery('');
    expect(result.q).toBe('');
    expect(result.filters).toEqual({});
  });
});
