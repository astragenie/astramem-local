/**
 * tests/service/task-xml.test.ts — Task Scheduler XML generation (D1),
 * including the issue #370 dual-trigger fix: a `<TimeTrigger>` alongside the
 * `<LogonTrigger>` so the repetition arms immediately at registration
 * instead of waiting for the next logon.
 */
import { describe, it, expect } from 'vitest';
import { buildTaskXml, buildDailyTaskXml, DEFAULT_REPETITION_SEC } from '../../src/service/task-xml.js';

const BASE_OPTS = {
  command: 'C:\\app\\shim.cmd',
  userId: 'DOMAIN\\user',
};

describe('buildTaskXml', () => {
  it('emits both a LogonTrigger and a TimeTrigger (issue #370)', () => {
    const xml = buildTaskXml(BASE_OPTS);
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<TimeTrigger>');
  });

  it('the TimeTrigger carries a StartBoundary and defaults it to "now" when unset', () => {
    const before = new Date();
    const xml = buildTaskXml(BASE_OPTS);
    const after = new Date();
    const m = xml.match(/<TimeTrigger>\s*<StartBoundary>([^<]+)<\/StartBoundary>/);
    expect(m).toBeTruthy();
    const boundary = m![1]!;
    // Naive local timestamp, no ms/offset: "YYYY-MM-DDTHH:mm:ss".
    expect(boundary).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    const parsed = new Date(boundary);
    expect(parsed.getTime()).toBeGreaterThanOrEqual(before.setSeconds(before.getSeconds() - 1));
    expect(parsed.getTime()).toBeLessThanOrEqual(after.setSeconds(after.getSeconds() + 1));
  });

  it('honors an explicit startBoundaryIso override', () => {
    const xml = buildTaskXml({ ...BASE_OPTS, startBoundaryIso: '2026-07-16T05:50:00' });
    expect(xml).toContain('<StartBoundary>2026-07-16T05:50:00</StartBoundary>');
  });

  it('the LogonTrigger and TimeTrigger share the exact same Repetition interval', () => {
    const xml = buildTaskXml({ ...BASE_OPTS, repetitionIso: 'PT180S' });
    const intervals = [...xml.matchAll(/<Interval>([^<]+)<\/Interval>/g)].map(m => m[1]);
    expect(intervals).toEqual(['PT180S', 'PT180S']);
  });

  it('both triggers repeat with no StopAtDurationEnd cutoff', () => {
    const xml = buildTaskXml(BASE_OPTS);
    const stops = [...xml.matchAll(/<StopAtDurationEnd>([^<]+)<\/StopAtDurationEnd>/g)].map(m => m[1]);
    expect(stops).toEqual(['false', 'false']);
  });

  it('preserves the ExecutionTimeLimit=PT0S / MultipleInstancesPolicy=IgnoreNew invariants', () => {
    const xml = buildTaskXml(BASE_OPTS);
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  });

  it('DEFAULT_REPETITION_SEC matches the PT5M default (300s)', () => {
    expect(DEFAULT_REPETITION_SEC).toBe(300);
    const xml = buildTaskXml(BASE_OPTS);
    expect(xml).toContain('<Interval>PT5M</Interval>');
  });
});

describe('buildDailyTaskXml', () => {
  it('replaces the whole Triggers block with a single CalendarTrigger — no leftover LogonTrigger or TimeTrigger', () => {
    const xml = buildDailyTaskXml({ ...BASE_OPTS, startTime: '03:00:00' });
    expect(xml).toContain('<CalendarTrigger>');
    expect(xml).not.toContain('<LogonTrigger>');
    expect(xml).not.toContain('<TimeTrigger>');
    // Exactly one <Triggers> open tag, still well-formed.
    expect(xml.match(/<Triggers>/g)).toHaveLength(1);
    expect(xml.match(/<\/Triggers>/g)).toHaveLength(1);
  });

  it('keeps the rest of the task definition (Settings/Actions) intact', () => {
    const xml = buildDailyTaskXml(BASE_OPTS);
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain(BASE_OPTS.command);
  });
});
