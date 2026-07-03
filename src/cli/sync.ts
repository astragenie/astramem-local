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

export async function syncCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const jsonMode = rest.includes('--json') || args.includes('--json');

  switch (sub) {
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

Push (local -> cloud) runs automatically inside the daemon when
sync.enabled=true (see \`astramem-local pair\`) — it has no CLI subcommand.`);
      if (sub !== undefined && sub !== '--help' && sub !== '-h') process.exit(1);
  }
}
