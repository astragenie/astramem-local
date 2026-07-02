/**
 * Persisted sync settings — written by `astramem-local pair`, merged into
 * Config.sync at daemon boot (Wave 3e). Kept as a small JSON file beside
 * config.yaml because pairing happens after init and must survive restarts;
 * the device token itself never lands here — it lives in the OS credential
 * store (keystore.ts storeSyncToken) or ASTRA_SYNC_TOKEN.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SyncSettings {
  enabled: boolean;
  url: string;
  workspaceId: string;
  tenantId?: string;
}

const FILE = 'sync.json';

export function syncSettingsPath(configDir: string): string {
  return join(configDir, FILE);
}

export function readSyncSettings(configDir: string): SyncSettings | null {
  try {
    const raw = JSON.parse(readFileSync(syncSettingsPath(configDir), 'utf8')) as Partial<SyncSettings>;
    if (typeof raw.url !== 'string' || typeof raw.workspaceId !== 'string') return null;
    return {
      enabled: raw.enabled === true,
      url: raw.url,
      workspaceId: raw.workspaceId,
      ...(typeof raw.tenantId === 'string' ? { tenantId: raw.tenantId } : {}),
    };
  } catch {
    return null; // missing or corrupt — daemon falls back to config defaults
  }
}

export function writeSyncSettings(configDir: string, settings: SyncSettings): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(syncSettingsPath(configDir), JSON.stringify(settings, null, 2), 'utf8');
}
