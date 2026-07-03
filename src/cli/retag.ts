/**
 * `astramem-local retag [--dry-run] [--limit N] [--tier2] [--no-tier2]
 *                        [--confidence N] [--json]`
 *
 * FEAT-403 (W4.3) — one-shot repo/project tag-hygiene backfill. Scans
 * memories with null/empty repo or project, derives tags tier-1 (session
 * cwd/project_id) then optionally tier-2 (LLM-assisted, confidence-gated).
 * See src/tag-hygiene/backfill.ts for the core (DB-only, testable) logic.
 *
 * tier-2 defaults to OFF (config.tagHygiene.tier2Enabled=false) — a
 * data-mutating heuristic pass over legacy rows carries real mis-tag risk,
 * so it is opt-in via --tier2 or config, never silently on.
 */

import { openRuntimeDb } from './open-runtime-db.js';
import { getProviders } from '../providers/index.js';
import { runTagHygieneBackfill, type BackfillResult } from '../tag-hygiene/backfill.js';
import { makeLlmTier2Infer } from '../tag-hygiene/tier2-infer.js';

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function retagCommand(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const limitArg = parseArg(args, '--limit');
  const limit = limitArg ? Math.max(1, Number(limitArg)) : undefined;
  const confidenceArg = parseArg(args, '--confidence');

  const { db, cfg } = openRuntimeDb();

  const tier2Enabled = args.includes('--tier2')
    ? true
    : args.includes('--no-tier2')
      ? false
      : cfg.tagHygiene.tier2Enabled;
  const confidenceThreshold = confidenceArg !== undefined
    ? Number(confidenceArg)
    : cfg.tagHygiene.tier2ConfidenceThreshold;

  const tier2Infer = tier2Enabled ? makeLlmTier2Infer(getProviders(cfg).llm.extraction) : undefined;

  const result: BackfillResult = await runTagHygieneBackfill(
    db,
    { dryRun, limit, tier2Enabled, confidenceThreshold },
    tier2Infer,
  );

  db.close();

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('');
  console.log('  AstraMemory Tag Hygiene Backfill');
  console.log('  ──────────────────────────────');
  console.log(`  Scanned: ${result.scanned}`);
  console.log(`  Tier-1 tagged (session metadata): ${result.tier1Applied}`);
  console.log(`  Tier-2 tagged (prompt-assisted, confidence >= ${confidenceThreshold}): ${result.tier2Applied}`);
  console.log(`  Left untagged: ${result.leftUntagged}`);
  if (dryRun) {
    console.log('  --dry-run: no rows were mutated. Proposed changes:');
    for (const c of result.candidates) {
      if (c.tier === null) continue;
      console.log(
        `    ${c.id}: repo ${c.currentRepo ?? 'null'} -> ${c.proposedRepo ?? 'null'}, ` +
        `project ${c.currentProject ?? 'null'} -> ${c.proposedProject ?? 'null'} (tier ${c.tier})`,
      );
    }
  }
  console.log('');
}
