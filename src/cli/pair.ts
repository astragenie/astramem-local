/**
 * `astramem-local pair <code> --url <cloud-url>` — Wave 3e device pairing.
 *
 * Redeems a FEAT-278 claim code against the cloud (possession of code =
 * credential; POST /claims/{code}/redeem, no auth) and wires up sync:
 *   1. the returned ApiKey goes into the OS credential store as the sync
 *      device token (never written to disk in plaintext),
 *   2. url/workspaceId land in <configDir>/sync.json with enabled=true,
 *      merged into Config.sync at the next daemon start.
 *
 * Claim codes come from the AstraMemory dashboard (POST /me/claims).
 */

import { defaultConfigDir } from '../config/datadir.js';
import { writeSyncSettings } from '../config/sync-settings.js';
import { storeSyncToken } from '../storage/keystore.js';

export interface RedeemResponse {
  apiUrl: string;
  tenantId: string;
  workspaceId: string;
  apiKey: string;
}

export type RedeemResult =
  | { ok: true; data: RedeemResponse }
  | { ok: false; status: number; message: string };

/** POST /claims/{code}/redeem. Exposed for tests via injectable fetch. */
export async function redeemClaim(
  cloudUrl: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RedeemResult> {
  const res = await fetchImpl(`${cloudUrl.replace(/\/$/, '')}/claims/${encodeURIComponent(code)}/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });

  if (res.status === 410) {
    return { ok: false, status: 410, message: 'claim code expired, already redeemed, or unknown — issue a fresh code from the dashboard' };
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after') ?? '60';
    return { ok: false, status: 429, message: `rate limited — retry in ${retryAfter}s` };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, message: `cloud returned HTTP ${res.status}` };
  }

  const body = await res.json() as Partial<RedeemResponse>;
  if (!body.apiKey || !body.workspaceId || !body.apiUrl) {
    return { ok: false, status: res.status, message: 'redeem succeeded but response was missing apiKey/workspaceId/apiUrl' };
  }
  return { ok: true, data: body as RedeemResponse };
}

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function pairCommand(args: string[]): Promise<void> {
  const code = args.find(a => !a.startsWith('-'));
  const cloudUrl = parseArg(args, '--url') ?? process.env.ASTRA_SYNC_URL;

  if (!code || !cloudUrl) {
    console.error('usage: astramem-local pair <claim-code> --url <cloud-url>   (or set ASTRA_SYNC_URL)');
    process.exit(1);
  }

  const result = await redeemClaim(cloudUrl, code);
  if (!result.ok) {
    console.error(`pair failed (HTTP ${result.status}): ${result.message}`);
    process.exit(1);
  }

  const { apiUrl, tenantId, workspaceId, apiKey } = result.data;

  const stored = storeSyncToken(apiKey);
  const configDir = defaultConfigDir();
  writeSyncSettings(configDir, { enabled: true, url: apiUrl, workspaceId, tenantId });

  console.log('✓ paired with AstraMemory cloud');
  console.log(`  workspace : ${workspaceId}`);
  console.log(`  api url   : ${apiUrl}`);
  console.log(`  token     : ${stored.stored ? 'stored in OS credential store' : 'NOT stored — set ASTRA_SYNC_TOKEN yourself'}`);
  console.log('\nRestart the daemon to start the sync shipper (team/org-scoped memories only — personal never syncs).');
}
