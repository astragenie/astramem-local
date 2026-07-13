/**
 * `astramem-local budget [--reset]`
 *
 * Shows today's LLM spend and month total versus the configured cap.
 * --reset clears today's row (override, logged) AND requeues any job the
 * worker paused on the cap that was just cleared (FEAT-482) — without this,
 * `--reset` only zeroed the spend counter and a paused job (distill OR
 * consolidate; see JobRepo.requeuePaused's doc comment) had no way back to
 * 'pending' at all.
 */

import { BudgetTracker } from '../budget/tracker.js';
import { JobRepo } from '../pipeline/job-repo.js';
import { openRuntimeDb } from './open-runtime-db.js';

export async function budgetCommand(args: string[]): Promise<void> {
  const doReset = args.includes('--reset');
  // Key-aware + config.yaml-aware open (same resolution as serve/doctor).
  const { db, cfg } = openRuntimeDb();

  const tracker = new BudgetTracker(db);

  if (doReset) {
    tracker.resetToday();
    const requeued = new JobRepo(db).requeuePaused();
    console.log('Today\'s budget has been reset to $0.00.');
    if (requeued > 0) {
      console.log(`  ${requeued} paused job(s) requeued.`);
    }
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
    console.log('      Run: astramem-local budget --reset  to override.');
  } else if (cap > 0 && today.usd_total / cap >= 0.8) {
    console.log('  [!] 80% of daily cap used — approaching limit.');
  }

  db.close();
}
