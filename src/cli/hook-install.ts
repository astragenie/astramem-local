/**
 * hook-install.ts — SessionStart memory-pack hook auto-install.
 *
 * Deferred from KF-B (docs/hooks/memory-pack.md shipped the manual-install
 * recipe; this wires it into `astramem-local init`). Installs the
 * platform-appropriate one-liner into the user's global Claude Code settings
 * (`~/.claude/settings.json` by default, injectable via `settingsPath` for
 * tests and callers that target a project-local settings file instead).
 *
 * Read-modify-write: parses existing JSON, appends one SessionStart hook
 * block, and writes the whole object back — every other key (and every other
 * hook) survives untouched. Idempotent: detects an already-installed
 * astramem hook by the `/recall/pack` marker substring in any existing
 * SessionStart command and skips re-inserting it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';

/** Marker substring used to detect an already-installed astramem hook (idempotency). */
export const HOOK_MARKER = '/recall/pack';

/** Default target: `~/.claude/settings.json` (global, matches docs/hooks/memory-pack.md). */
export function defaultSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

/**
 * Build the platform-appropriate SessionStart hook one-liner from
 * docs/hooks/memory-pack.md, with the daemon port filled in.
 *
 * Uses `MEMORY_BEARER` (the env var `astramem-local init` actually persists
 * to the user's shell — see src/config/persist-envs.ts and the `.mcp.json`
 * wiring in README.md), not the doc's original `ASTRAMEM_TOKEN` placeholder.
 */
export function buildHookCommand(port: number): string {
  const url = `http://127.0.0.1:${port}/recall/pack`;
  if (platform() === 'win32') {
    return (
      `powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Method Post -Uri ${url} ` +
      `-Headers @{Authorization=\\"Bearer $env:MEMORY_BEARER\\"} -ContentType application/json ` +
      `-Body (@{repo=(Split-Path -Leaf (Get-Location))} | ConvertTo-Json) -TimeoutSec 2; ` +
      `if ($r.pack) { $r.pack } } catch {}"`
    );
  }
  return (
    `curl -s -m 2 -X POST ${url} -H "Authorization: Bearer $MEMORY_BEARER" ` +
    `-H "Content-Type: application/json" -d "{\\"repo\\": \\"$(basename \\"$PWD\\")\\"}" | ` +
    `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const p=JSON.parse(d).pack;if(p)console.log(p)}catch{}})"`
  );
}

interface SessionStartHook {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface SessionStartBlock {
  hooks?: SessionStartHook[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: {
    SessionStart?: SessionStartBlock[];
    [event: string]: unknown;
  };
  [key: string]: unknown;
}

export interface InstallHookOptions {
  /** Daemon port to bake into the hook URL. */
  port: number;
  /** Injectable target path — defaults to defaultSettingsPath(). */
  settingsPath?: string;
}

export type InstallHookOutcome = 'installed' | 'already-installed';

export interface InstallHookResult {
  outcome: InstallHookOutcome;
  settingsPath: string;
}

/**
 * Install the SessionStart memory-pack hook into `opts.settingsPath`
 * (default `~/.claude/settings.json`). Preserves all existing content;
 * idempotent against repeated calls.
 */
export function installMemoryPackHook(opts: InstallHookOptions): InstallHookResult {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf8');
    try {
      settings = raw.trim() === '' ? {} : (JSON.parse(raw) as ClaudeSettings);
    } catch {
      throw new Error(
        `hook-install: ${settingsPath} contains invalid JSON — fix or remove it before retrying`
      );
    }
  }

  const hooks = settings.hooks ?? {};
  const sessionStart = hooks.SessionStart ?? [];

  const alreadyInstalled = sessionStart.some((block) =>
    (block.hooks ?? []).some(
      (h) => typeof h.command === 'string' && h.command.includes(HOOK_MARKER)
    )
  );
  if (alreadyInstalled) {
    return { outcome: 'already-installed', settingsPath };
  }

  sessionStart.push({
    hooks: [{ type: 'command', command: buildHookCommand(opts.port), timeout: 3 }],
  });
  hooks.SessionStart = sessionStart;
  settings.hooks = hooks;

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');

  return { outcome: 'installed', settingsPath };
}
