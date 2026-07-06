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

/** Prod cloud API host — root-relative, no /api prefix (astragenie/common
 *  #167/#169). Used when no --url / ASTRA_SYNC_URL is given so `pair <code>`
 *  just works against prod. Override for staging / self-hosted. */
export const DEFAULT_CLOUD_URL = 'https://api.astramemory.com';

export type UrlSource = 'flag' | 'env' | 'default';

/** Resolve the redeem target: explicit --url wins over ASTRA_SYNC_URL wins
 *  over the prod default (astramem-local#85). Pure — exported for tests. */
export function resolveCloudUrl(flagUrl?: string, envUrl?: string): { cloudUrl: string; urlSource: UrlSource } {
  const urlSource: UrlSource = flagUrl ? 'flag' : envUrl ? 'env' : 'default';
  return { cloudUrl: flagUrl ?? envUrl ?? DEFAULT_CLOUD_URL, urlSource };
}

/** Sync base to persist: an explicit operator url wins over the cloud-echoed
 *  apiUrl; with no override, trust the redeem response (astramem-local#85). */
export function resolveSyncBase(urlSource: UrlSource, cloudUrl: string, responseApiUrl: string): string {
  return urlSource === 'default' ? responseApiUrl : cloudUrl.replace(/\/$/, '');
}

export async function pairCommand(args: string[]): Promise<void> {
  const code = args.find(a => !a.startsWith('-'));
  const { cloudUrl, urlSource } = resolveCloudUrl(parseArg(args, '--url'), process.env.ASTRA_SYNC_URL);

  if (!code) {
    console.error('usage: astramem-local pair <claim-code> [--url <cloud-url>]   (default: ' + DEFAULT_CLOUD_URL + '; or set ASTRA_SYNC_URL)');
    process.exit(1);
  }

  const result = await redeemClaim(cloudUrl, code);
  if (!result.ok) {
    console.error(`pair failed (HTTP ${result.status}): ${result.message}`);
    process.exit(1);
  }

  const { apiUrl: responseApiUrl, tenantId, workspaceId, apiKey } = result.data;

  // Sync-base precedence (astramem-local#85): an explicit operator --url /
  // ASTRA_SYNC_URL wins over the cloud-echoed apiUrl (so pointing at a
  // specific deployment is not silently overridden). With no override, trust
  // the redeem response. Always log which base won and why.
  const syncBase = resolveSyncBase(urlSource, cloudUrl, responseApiUrl);
  const baseSource = urlSource === 'default' ? 'redeem response' : `--url (${urlSource})`;

  const stored = storeSyncToken(apiKey);
  const configDir = defaultConfigDir();
  writeSyncSettings(configDir, { enabled: true, url: syncBase, workspaceId, tenantId });

  console.log('✓ paired with AstraMemory cloud');
  console.log(`  workspace : ${workspaceId}`);
  console.log(`  sync base : ${syncBase}  (source: ${baseSource})`);
  if (urlSource !== 'default' && responseApiUrl.replace(/\/$/, '') !== syncBase) {
    console.log(`  note      : cloud echoed a different apiUrl (${responseApiUrl}) — using your --url instead`);
  }
  console.log(`  token     : ${stored.stored ? 'stored in OS credential store' : 'NOT stored — set ASTRA_SYNC_TOKEN yourself'}`);
  console.log('\nRestart the daemon to start the sync shipper (team/org-scoped memories only — private never syncs).');
}
