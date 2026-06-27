import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CheckResult } from '../types.js';

interface McpJson {
  mcpServers?: Record<string, { url?: string; env?: Record<string, string> }>;
}

/**
 * Plugin coexistence probe: detects silent URL mismatches between the running
 * daemon and any plugin config that might route traffic elsewhere.
 *
 * Checks:
 * 1. MEMORY_API_URL env — if set, must point at this daemon's loopback:port.
 * 2. Common .mcp.json locations — if found, the mcpServers.memory.url must
 *    point at this daemon's port, not a SaaS endpoint or different port.
 *
 * Risk addressed: spec risk #4 — user with both SaaS and local plugin config
 * gets silent ambiguity about which backend their queries hit.
 */
export async function pluginCoexistenceProbe(
  daemonPort: number,
): Promise<CheckResult> {
  const indicators: string[] = [];

  // ── 1. MEMORY_API_URL env ──────────────────────────────────────────────────
  const envUrl = process.env.MEMORY_API_URL;
  if (envUrl) {
    const pointsHere =
      envUrl.includes(`127.0.0.1:${daemonPort}`) ||
      envUrl.includes(`localhost:${daemonPort}`);
    if (!pointsHere) {
      indicators.push(
        `MEMORY_API_URL=${envUrl} (not pointing at this daemon at :${daemonPort})`,
      );
    }
  }

  // ── 2. Scan likely .mcp.json locations ────────────────────────────────────
  const candidates = [
    join(homedir(), '.claude', 'plugins', 'memory-plugin', '.mcp.json'),
    join(process.cwd(), '.mcp.json'),
    join(homedir(), 'mega', 'astramemory-plugin', '.mcp.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const raw = readFileSync(candidate, 'utf8');
        const content = JSON.parse(raw) as McpJson;
        const memUrl = content.mcpServers?.['memory']?.url;
        if (
          memUrl &&
          !memUrl.includes(`127.0.0.1:${daemonPort}`) &&
          !memUrl.includes(`localhost:${daemonPort}`)
        ) {
          indicators.push(
            `Plugin .mcp.json at ${candidate} points at ${memUrl}, not this daemon`,
          );
        }
      } catch {
        // JSON parse errors are non-fatal — file may be from another plugin
      }
    }
  }

  // ── Result ────────────────────────────────────────────────────────────────
  if (indicators.length > 0) {
    return {
      ok: false,
      message: `Plugin config does not point at this daemon: ${indicators.join('; ')}`,
      fix:
        `Set MEMORY_API_URL=http://127.0.0.1:${daemonPort} and update plugin .mcp.json`,
    };
  }

  return { ok: true, message: 'Plugin config aligned with daemon port' };
}
