/**
 * `astramem-local sync pull [--json] [--batch-size N]` — FEAT-407, one-shot
 * cloud -> local pull. Opens the runtime DB directly (same pattern as
 * queue/budget/rebuild — see open-runtime-db.ts), unlike consolidate.ts
 * which proxies over HTTP to a running daemon: pull is a merge operation
 * against the local event log/watermark, not a daemon-only in-memory
 * concern, so a one-shot CLI invocation (daemon running or not) is the
 * right shape, mirroring how `backup`/`restore` work directly against the
 * DB file.
 *
 * Requires the same sync config the shipper uses (cfg.sync.url/workspaceId
 * + a device token) — pull piggybacks on the existing pairing flow
 * (`astramem-local pair`), no separate credential story.
 */

import { openRuntimeDb } from './open-runtime-db.js';
import { readSyncToken } from '../storage/keystore.js';
import { drainPull, httpPullFetcher, getPullWatermark } from '../sync/puller.js';
import { planBackfill, applyBackfill, planReship, applyReship } from '../sync/backfill.js';

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function syncCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const jsonMode = rest.includes('--json') || args.includes('--json');

  switch (sub) {
    // Backfill + bulk-promote so existing memories can sync to the cloud.
    // DESTRUCTIVE + IRREVERSIBLE (scope is upward-only) — dry-run unless --yes.
    case 'backfill': {
      const project = flagValue(rest, '--project') ?? null;
      const apply = rest.includes('--yes');
      const scopeArg = flagValue(rest, '--scope');

      // --reship (astramem-local#97): fix already-synced create events whose
      // cloud replica materialized empty because they shipped before #86's
      // payload fix. Distinct from the default mode below, which only ever
      // touches NOT-yet-synced rows.
      if (rest.includes('--reship')) {
        const reshipScope = scopeArg === 'team' || scopeArg === 'org' ? scopeArg : undefined;
        const { db } = openRuntimeDb();
        const plan = planReship(db, { scope: reshipScope, project });

        console.log(`sync backfill --reship — ${apply ? 'APPLY' : 'DRY RUN'}${project ? ` (project=${project})` : ''}`);
        console.log(`  scope                                    : ${plan.scope}`);
        console.log(`  create events to backfill+reship (null payload, already-synced team/org): ${plan.createEventsToBackfillAndReship}`);

        if (!apply) {
          console.log('\nDRY RUN — nothing changed.');
          console.log('Re-run with --yes to backfill payload + reset synced_at so the shipper re-sends. Stop the daemon first: `node dist/cli/index.js service stop`.');
          break;
        }

        const result = applyReship(db, { scope: reshipScope, project });
        console.log(`\n✓ backfilled + reset synced_at on ${result.reshipped} create-event payload(s) — shipper will re-send them.`);
        console.log('Restart the daemon to ship the backlog: `node dist/cli/index.js reinstall`.');
        break;
      }

      const scope = scopeArg === 'org' ? 'org' : 'team';
      const { db } = openRuntimeDb();
      const plan = planBackfill(db, { scope, project });

      console.log(`sync backfill — ${apply ? 'APPLY' : 'DRY RUN'}${project ? ` (project=${project})` : ''}`);
      console.log(`  target scope        : ${scope}  (cloud: ${scope === 'org' ? 'shared' : 'project'})`);
      console.log(`  personal → promote  : ${plan.personalToPromote}`);
      console.log(`  already team/org    : ${plan.alreadyShareable}`);
      console.log(`  create events to backfill (null payload, unsynced): ${plan.createEventsToBackfill}`);

      if (!apply) {
        console.log('\nDRY RUN — nothing changed. IRREVERSIBLE once applied (scope is upward-only).');
        console.log('Re-run with --yes to promote + backfill and ship to the cloud. Stop the daemon first: `node dist/cli/index.js service stop`.');
        break;
      }

      const result = applyBackfill(db, { scope, project });
      console.log(`\n✓ promoted ${result.promoted} personal → ${scope}; backfilled ${result.backfilled} create-event payload(s).`);
      console.log('Restart the daemon to ship the backlog: `node dist/cli/index.js reinstall`.');
      break;
    }

    case 'pull': {
      const { db, cfg } = openRuntimeDb();
      const token = process.env.ASTRA_SYNC_TOKEN ?? readSyncToken();
      if (!cfg.sync.url || !cfg.sync.workspaceId || !token) {
        console.error('sync pull: sync.enabled url/workspaceId/device-token incomplete — run `astramem-local pair` first.');
        process.exit(1);
      }
      const fetcher = httpPullFetcher(cfg.sync.url, token as string);
      const result = await drainPull({ db, fetcher, batchSize: cfg.sync.batchSize });
      if (jsonMode) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`Pull complete: ${result.rounds} round(s), ${result.totalFetched} event(s) fetched, ${result.totalInserted} new.`);
        console.log(`Watermark: ${result.cursor ?? '(none)'}`);
      }
      break;
    }

    case 'watermark': {
      const { db } = openRuntimeDb();
      const watermark = getPullWatermark(db);
      console.log(jsonMode ? JSON.stringify({ watermark }) : `Pull watermark: ${watermark ?? '(none — pull has never run)'}`);
      break;
    }

    default:
      console.log(`astramem-local sync <subcommand>

Subcommands:
  pull [--json]        Pull events from the cloud since the last watermark,
                        merge (dedup by event_id, ADR-011 conflict resolve),
                        advance + persist the watermark.
  watermark [--json]   Show the current persisted pull watermark.
  backfill [--scope team|org] [--project X] [--yes]
                        Bulk-promote personal memories + backfill create-event
                        content so existing memories sync to the cloud. Dry-run
                        unless --yes. IRREVERSIBLE (scope is upward-only).
  backfill --reship [--scope team|org] [--project X] [--yes]
                        Fix already-synced team/org create events whose cloud
                        replica materialized empty (shipped before #86's
                        payload fix): backfill payload + reset synced_at so
                        the shipper re-sends them. Dry-run unless --yes.
                        Idempotent; scope-safe (team/org only).

Push (local -> cloud) runs automatically inside the daemon when
sync.enabled=true (see \`astramem-local pair\`) — it has no CLI subcommand.`);
      if (sub !== undefined && sub !== '--help' && sub !== '-h') process.exit(1);
  }
}
