import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { BudgetTracker, BudgetExceeded } from '../../src/budget/tracker.js';
import type { DB } from '../../src/storage/db.js';

describe('BudgetTracker', () => {
  let db: DB;
  let tracker: BudgetTracker;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    tracker = new BudgetTracker(db);
  });

  it('today() returns zero row when no spend recorded', () => {
    const t = tracker.today();
    expect(t.usd_total).toBe(0);
    expect(t.calls).toBe(0);
    expect(t.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('record() increments usd_total and calls', () => {
    tracker.record(0.001);
    tracker.record(0.002);
    const t = tracker.today();
    expect(t.usd_total).toBeCloseTo(0.003);
    expect(t.calls).toBe(2);
  });

  it('canSpend() returns true when within cap', () => {
    tracker.record(1.0);
    expect(tracker.canSpend(8.0, 10.0)).toBe(true);
  });

  it('canSpend() returns false when estimate would exceed cap', () => {
    tracker.record(9.5);
    expect(tracker.canSpend(1.0, 10.0)).toBe(false);
  });

  it('canSpend() returns true at exact boundary', () => {
    tracker.record(9.0);
    expect(tracker.canSpend(1.0, 10.0)).toBe(true);
  });

  it('assertCanSpend() throws BudgetExceeded when over cap', () => {
    tracker.record(9.5);
    expect(() => tracker.assertCanSpend(1.0, 10.0)).toThrow(BudgetExceeded);
  });

  it('assertCanSpend() does not throw when within cap', () => {
    tracker.record(1.0);
    expect(() => tracker.assertCanSpend(1.0, 10.0)).not.toThrow();
  });

  it('BudgetExceeded has correct name', () => {
    const err = new BudgetExceeded(9.5, 10.0, 1.0);
    expect(err.name).toBe('BudgetExceeded');
    expect(err.message).toContain('Budget cap exceeded');
    expect(err.dayTotal).toBe(9.5);
    expect(err.cap).toBe(10.0);
    expect(err.estimateUsd).toBe(1.0);
  });

  it('resetToday() clears the day row', () => {
    tracker.record(5.0);
    tracker.resetToday();
    const t = tracker.today();
    expect(t.usd_total).toBe(0);
    expect(t.calls).toBe(0);
  });

  it('monthTotal() sums all days with current month prefix', () => {
    tracker.record(1.0);
    tracker.record(2.0);
    const m = tracker.monthTotal();
    expect(m.usd_total).toBeCloseTo(3.0);
    expect(m.calls).toBe(2);
    expect(m.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it('estimateUsd() computes cost from char count', () => {
    // 4000 chars / 4 = 1000 input tokens; 500 output; at $0.000002 each
    const usd = BudgetTracker.estimateUsd(4000, 0.000002, 0.000002);
    expect(usd).toBeCloseTo(1000 * 0.000002 + 500 * 0.000002);
  });
});
