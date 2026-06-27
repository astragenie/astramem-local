/**
 * `astra-memory budget [--reset]`
 *
 * Shows today's LLM spend and month total versus the configured cap.
 * --reset clears today's row (override, logged).
 */

import { join } from 'node:path';
import { openDb } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';
import { BudgetTracker } from '../budget/tracker.js';
import { defaultConfig } from '../config/config.js';

export async function budgetCommand(args: string[]): Promise<void> {
  const doReset = args.includes('--reset');
  const cfg = defaultConfig();
  const dataDir = process.env.ASTRA_MEMORY_DATADIR ?? cfg.dataDir;

  const dbPath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'memory.sqlite');
  const db = openDb(dbPath);
  migrate(db);

  const tracker = new BudgetTracker(db);

  if (doReset) {
    tracker.resetToday();
    console.log('Today\'s budget has been reset to $0.00.');
  }

  const today = tracker.today();
  const month = tracker.monthTotal();
  const cap = cfg.budget.daily_usd;

  const pct = cap > 0 ? ((today.usd_total / cap) * 100).toFixed(1) : '—';

  console.log('');
  console.log('  AstraMemory Budget');
  console.log('  ──────────────────────────────');
  console.log(`  Today (${today.day})`);
  console.log(`    Spend:  $${today.usd_total.toFixed(4)}`);
  console.log(`    Cap:    $${cap.toFixed(2)}`);
  console.log(`    Usage:  ${pct}%`);
  console.log(`    Calls:  ${today.calls}`);
  console.log('');
  console.log(`  Month (${month.month})`);
  console.log(`    Spend:  $${month.usd_total.toFixed(4)}`);
  console.log(`    Calls:  ${month.calls}`);
  console.log('');

  if (today.usd_total >= cap) {
    console.log('  [!] Daily cap reached — distillation is paused until tomorrow.');
    console.log('      Run: astra-memory budget --reset  to override.');
  } else if (cap > 0 && today.usd_total / cap >= 0.8) {
    console.log('  [!] 80% of daily cap used — approaching limit.');
  }

  db.close();
}
