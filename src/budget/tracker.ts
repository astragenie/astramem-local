/**
 * Budget tracker — daily LLM spend enforcement.
 *
 * Backed by the budget_spend table (day TEXT PRIMARY KEY, usd_total REAL, calls INTEGER).
 * All DB ops are synchronous (better-sqlite3).
 */

import type { DB } from '../storage/db.js';

export class BudgetExceeded extends Error {
  constructor(
    public readonly dayTotal: number,
    public readonly cap: number,
    public readonly estimateUsd: number,
  ) {
    super(
      `Budget cap exceeded: today=$${dayTotal.toFixed(4)} + estimate=$${estimateUsd.toFixed(4)} > cap=$${cap.toFixed(2)}`,
    );
    this.name = 'BudgetExceeded';
  }
}

export interface DaySpend {
  day: string;
  usd_total: number;
  calls: number;
}

export class BudgetTracker {
  constructor(private readonly db: DB) {}

  /** Return today's spend row (or a zeroed row if none exists yet). */
  today(): DaySpend {
    const day = todayKey();
    const row = this.db
      .prepare('SELECT day, usd_total, calls FROM budget_spend WHERE day = ?')
      .get(day) as DaySpend | undefined;
    return row ?? { day, usd_total: 0, calls: 0 };
  }

  /**
   * Add usd to today's running total and increment call count.
   * Uses INSERT OR REPLACE so the first call creates the row.
   */
  record(usd: number): void {
    const day = todayKey();
    this.db
      .prepare(`
        INSERT INTO budget_spend (day, usd_total, calls)
        VALUES (?, ?, 1)
        ON CONFLICT(day) DO UPDATE SET
          usd_total = usd_total + excluded.usd_total,
          calls     = calls + 1
      `)
      .run(day, usd);
  }

  /**
   * Return true if today's spend + estimateUsd would remain within capUsd.
   * Does NOT record spend — call record() after a successful LLM call.
   */
  canSpend(estimateUsd: number, capUsd: number): boolean {
    const { usd_total } = this.today();
    return usd_total + estimateUsd <= capUsd;
  }

  /**
   * Assert that we can spend estimateUsd against capUsd.
   * Throws BudgetExceeded if over cap.
   */
  assertCanSpend(estimateUsd: number, capUsd: number): void {
    const { usd_total } = this.today();
    if (usd_total + estimateUsd > capUsd) {
      throw new BudgetExceeded(usd_total, capUsd, estimateUsd);
    }
  }

  /**
   * Reset today's row to zero (user-initiated override).
   * Logs to stdout for audit trail.
   */
  resetToday(): void {
    const day = todayKey();
    this.db
      .prepare(
        'INSERT INTO budget_spend (day, usd_total, calls) VALUES (?, 0, 0) ON CONFLICT(day) DO UPDATE SET usd_total=0, calls=0',
      )
      .run(day);
    console.log(`[budget] reset: day=${day} usd_total reset to 0`);
  }

  /**
   * Estimate LLM cost for a call given prompt character count.
   * Uses: input_tokens ≈ chars/4, fixed 500 output tokens.
   * Returns USD (0 if this is an Ollama call — caller should pass 0).
   */
  static estimateUsd(promptChars: number, costPerInputToken: number, costPerOutputToken: number): number {
    const inputTokens = Math.ceil(promptChars / 4);
    const outputTokens = 500; // fixed max output estimate
    return inputTokens * costPerInputToken + outputTokens * costPerOutputToken;
  }

  /**
   * Month totals: sum up all days in the current calendar month (YYYY-MM prefix).
   */
  monthTotal(): { usd_total: number; calls: number; month: string } {
    const month = todayKey().slice(0, 7); // YYYY-MM
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(usd_total), 0) AS usd_total, COALESCE(SUM(calls), 0) AS calls
         FROM budget_spend WHERE day LIKE ?`,
      )
      .get(`${month}-%`) as { usd_total: number; calls: number };
    return { ...row, month };
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}
