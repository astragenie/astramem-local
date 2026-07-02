// Wave 3e — device pairing: claim-code redeem + persisted sync settings.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { redeemClaim } from '../../src/cli/pair.js';
import {
  readSyncSettings,
  writeSyncSettings,
  syncSettingsPath,
} from '../../src/config/sync-settings.js';

function fakeFetch(status: number, body?: unknown, headers?: Record<string, string>): typeof fetch {
  return (async () => new Response(
    body !== undefined ? JSON.stringify(body) : null,
    { status, headers },
  )) as unknown as typeof fetch;
}

describe('redeemClaim', () => {
  const GOOD = { apiUrl: 'https://api.astramemory.com', tenantId: 't-1', workspaceId: 'w-1', apiKey: 'ak_secret' };

  it('returns the redeem payload on 200', async () => {
    const result = await redeemClaim('https://cloud.example/', 'AB-CD', fakeFetch(200, GOOD));
    expect(result).toEqual({ ok: true, data: GOOD });
  });

  it('maps 410 to a no-oracle friendly message', async () => {
    const result = await redeemClaim('https://cloud.example', 'AB-CD', fakeFetch(410, {}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(410);
      expect(result.message).toContain('expired');
    }
  });

  it('maps 429 with Retry-After', async () => {
    const result = await redeemClaim('https://cloud.example', 'AB-CD', fakeFetch(429, {}, { 'retry-after': '42' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('42s');
  });

  it('rejects a 200 with missing fields rather than storing garbage', async () => {
    const result = await redeemClaim('https://cloud.example', 'AB-CD', fakeFetch(200, { apiUrl: 'x' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('missing');
  });
});

describe('sync settings persistence', () => {
  it('roundtrips, and readSyncSettings is null-safe on missing/corrupt files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astra-pair-'));
    try {
      expect(readSyncSettings(dir)).toBeNull();

      writeSyncSettings(dir, { enabled: true, url: 'https://api.x', workspaceId: 'w-9', tenantId: 't-9' });
      expect(readSyncSettings(dir)).toEqual({ enabled: true, url: 'https://api.x', workspaceId: 'w-9', tenantId: 't-9' });

      // Corrupt file → null, never a throw at daemon boot.
      writeFileSync(syncSettingsPath(dir), '{not json');
      expect(readSyncSettings(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
