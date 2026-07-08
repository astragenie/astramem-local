/**
 * `astramem-local mcp install --client <name> [--url URL] [--dry-run]`
 *
 * Writes (or updates) the target MCP client's config file so it points at
 * this daemon's `POST /mcp` route with a Bearer token — the same wiring
 * documented in README.md's "MCP tools" section (`.mcp.json` with
 * `{ type: 'http', url, headers: { Authorization } }`), just automated
 * instead of hand-edited.
 *
 * Confidently implemented (file path + `mcpServers` schema verified against
 * each client's own docs, and matches this repo's existing plugin
 * `.mcp.json` convention): Claude Code project `.mcp.json`, Cursor
 * `~/.cursor/mcp.json`, Claude Desktop `claude_desktop_config.json`.
 *
 * `windsurf` and `vscode` print manual instructions instead of writing a
 * file — VS Code's MCP schema uses a `servers` key (not `mcpServers`) and
 * neither was exercised against a live client in this change, so guessing at
 * a write path there risks silently corrupting a config Claude never saw
 * fail. Both still get a copy-pasteable JSON snippet + the resolved URL/token.
 *
 * Idempotent: re-running with the same client updates the SAME key
 * (`astramem-local`) in place rather than duplicating entries — see
 * `mergeServersJson`. The existing file is copied to `<path>.bak` before
 * every write (skipped when the file didn't previously exist). `--dry-run`
 * prints the would-be file contents and makes no filesystem changes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { resolveBearerToken } from '../storage/bearer-keystore.js';

export const IMPLEMENTED_CLIENTS = ['claude', 'claude-code', 'cursor'] as const;
export const MANUAL_CLIENTS = ['windsurf', 'vscode'] as const;
export type ImplementedClient = (typeof IMPLEMENTED_CLIENTS)[number];
export type ManualClient = (typeof MANUAL_CLIENTS)[number];

export function isImplementedClient(client: string): client is ImplementedClient {
  return (IMPLEMENTED_CLIENTS as readonly string[]).includes(client);
}

export function isManualClient(client: string): client is ManualClient {
  return (MANUAL_CLIENTS as readonly string[]).includes(client);
}

export interface McpEntry {
  type: 'http';
  url: string;
  headers: { Authorization: string };
}

export function buildMcpEntry(url: string, token: string): McpEntry {
  return { type: 'http', url, headers: { Authorization: `Bearer ${token}` } };
}

/** Resolve the base `http://host:port/mcp` this daemon serves on, the same
 *  way `serve`/`doctor`/`reinstall` resolve port/host — an explicit `--url`
 *  wins outright (treated as the daemon's base URL; `/mcp` is appended). */
export function resolveMcpUrl(urlOverride?: string): string {
  if (urlOverride) {
    return `${urlOverride.replace(/\/$/, '')}/mcp`;
  }
  const { cfg, port } = resolveRuntimeConfig({});
  const host = cfg.network.host === '0.0.0.0' ? '127.0.0.1' : cfg.network.host;
  return `http://${host}:${port}/mcp`;
}

/** SEC-10 precedence (CLI > env > OS credential store > secrets.env >
 *  default) — the same resolver `serve` uses, so the token this command
 *  writes is the one the running daemon actually accepts. */
export function resolveMcpToken(): string {
  return resolveBearerToken({ envToken: process.env.ASTRA_MEMORY_TOKEN }).token;
}

/** Claude Desktop's config path per-OS. `homeDir`/`env`/`plat` are
 *  injectable so tests never touch the real OS paths. Linux Claude Desktop
 *  is unofficial/community-packaged; this mirrors the XDG-style path those
 *  builds commonly use. */
export function claudeDesktopConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  plat: NodeJS.Platform = platform(),
  homeDir: string = homedir(),
): string {
  if (plat === 'win32') {
    return join(env.APPDATA ?? join(homeDir, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  if (plat === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return join(env.XDG_CONFIG_HOME ?? join(homeDir, '.config'), 'Claude', 'claude_desktop_config.json');
}

export interface ClientTarget {
  path: string;
  serversKey: 'mcpServers';
  entryKey: string;
}

export interface ResolveClientTargetOpts {
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  plat?: NodeJS.Platform;
}

/** Where each implemented client's config lives, and the key(s) inside it we
 *  own. `opts` overrides are injection points for tests — production callers
 *  omit them and get the real cwd/homedir/env/platform. */
export function resolveClientTarget(client: ImplementedClient, opts: ResolveClientTargetOpts = {}): ClientTarget {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homeDir ?? homedir();
  const entryKey = 'astramem-local';
  switch (client) {
    case 'claude-code':
      return { path: join(cwd, '.mcp.json'), serversKey: 'mcpServers', entryKey };
    case 'cursor':
      return { path: join(home, '.cursor', 'mcp.json'), serversKey: 'mcpServers', entryKey };
    case 'claude':
      return {
        path: claudeDesktopConfigPath(opts.env ?? process.env, opts.plat ?? platform(), home),
        serversKey: 'mcpServers',
        entryKey,
      };
  }
}

/**
 * Pure merge: parses `existingText` (if any), upserts `entry` at
 * `parsed[serversKey][entryKey]`, and returns the pretty-printed result plus
 * whether the entry actually changed (idempotency signal — the CLI reports
 * "already up to date" when a second run is a no-op). Throws on invalid
 * existing JSON; the caller must surface that rather than silently
 * overwriting a file it couldn't parse.
 */
export function mergeServersJson(
  existingText: string | null,
  serversKey: string,
  entryKey: string,
  entry: Record<string, unknown>,
): { text: string; changed: boolean } {
  const parsed: Record<string, unknown> = existingText ? (JSON.parse(existingText) as Record<string, unknown>) : {};
  const rawServers = parsed[serversKey];
  const servers: Record<string, unknown> =
    rawServers && typeof rawServers === 'object' && !Array.isArray(rawServers)
      ? { ...(rawServers as Record<string, unknown>) }
      : {};
  const before = JSON.stringify(servers[entryKey] ?? null);
  servers[entryKey] = entry;
  const changed = before !== JSON.stringify(entry);
  const next = { ...parsed, [serversKey]: servers };
  return { text: `${JSON.stringify(next, null, 2)}\n`, changed };
}

function printManualInstructions(client: ManualClient, url: string, token: string): void {
  console.log(`astramem-local mcp install: no automated writer for "${client}" yet — wire it up manually.\n`);
  console.log(`  url   : ${url}`);
  console.log(`  token : ${token}\n`);
  if (client === 'windsurf') {
    console.log('Windsurf (Cascade) reads MCP servers from ~/.codeium/windsurf/mcp_config.json. Add an entry like:');
    console.log(JSON.stringify(
      { mcpServers: { 'astramem-local': { serverUrl: url, headers: { Authorization: `Bearer ${token}` } } } },
      null,
      2,
    ));
  } else {
    console.log('VS Code (GitHub Copilot MCP) reads servers from .vscode/mcp.json in your workspace. Add an entry like:');
    console.log(JSON.stringify(
      { servers: { 'astramem-local': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } },
      null,
      2,
    ));
  }
  console.log('\n(Field names can drift between client versions — check that client\'s current MCP docs if this does not load.)');
}

export interface RunMcpInstallOpts {
  client: string;
  urlOverride?: string;
  dryRun?: boolean;
  /** Injection points so tests exercise the real file-merge/backup logic
   *  against a fixture directory instead of the real OS paths / credential
   *  store. Production (mcpInstallCommand) omits all of these. */
  targetOpts?: ResolveClientTargetOpts;
  resolveUrl?: (urlOverride?: string) => string;
  resolveToken?: () => string;
}

export interface RunMcpInstallResult {
  ok: boolean;
  manual: boolean;
  path?: string;
  wrote: boolean;
  changed: boolean;
}

/**
 * Core logic shared by the CLI entry point and tests. Returns a result
 * object (rather than relying solely on console output + exit codes) so
 * tests can assert outcomes directly.
 */
export function runMcpInstall(opts: RunMcpInstallOpts): RunMcpInstallResult {
  const { client, urlOverride, dryRun = false } = opts;
  const resolveUrl = opts.resolveUrl ?? resolveMcpUrl;
  const resolveToken = opts.resolveToken ?? resolveMcpToken;
  const url = resolveUrl(urlOverride);

  if (isManualClient(client)) {
    printManualInstructions(client, url, resolveToken());
    return { ok: true, manual: true, wrote: false, changed: false };
  }

  if (!isImplementedClient(client)) {
    console.error(`mcp install: unknown client "${client}" (expected: ${[...IMPLEMENTED_CLIENTS, ...MANUAL_CLIENTS].join(', ')})`);
    return { ok: false, manual: false, wrote: false, changed: false };
  }

  const target = resolveClientTarget(client, opts.targetOpts);
  const token = resolveToken();
  const entry = buildMcpEntry(url, token);

  const exists = existsSync(target.path);
  const existingText = exists ? readFileSync(target.path, 'utf8') : null;

  let merged: { text: string; changed: boolean };
  try {
    merged = mergeServersJson(existingText, target.serversKey, target.entryKey, entry as unknown as Record<string, unknown>);
  } catch (err) {
    console.error(
      `mcp install: existing config at ${target.path} is not valid JSON — aborting rather than clobbering it ` +
      `(${err instanceof Error ? err.message : String(err)})`,
    );
    return { ok: false, manual: false, path: target.path, wrote: false, changed: false };
  }

  if (dryRun) {
    console.log(`# would write ${target.path}${exists ? ' (updating existing file)' : ' (new file)'}`);
    console.log(merged.text);
    return { ok: true, manual: false, path: target.path, wrote: false, changed: merged.changed };
  }

  mkdirSync(dirname(target.path), { recursive: true });
  if (exists) {
    copyFileSync(target.path, `${target.path}.bak`);
  }
  writeFileSync(target.path, merged.text, 'utf8');

  console.log(`${merged.changed ? '✓ installed' : '✓ already up to date'} — ${client} -> ${target.path}`);
  console.log(`  server : ${target.entryKey}`);
  console.log(`  url    : ${url}`);
  if (exists) console.log(`  backup : ${target.path}.bak`);
  if (client === 'claude') console.log('  note   : restart Claude Desktop to pick up the change');
  if (client === 'cursor') console.log('  note   : reload Cursor (Cmd/Ctrl+Shift+P -> Reload Window) to pick up the change');
  if (client === 'claude-code') console.log('  note   : restart Claude Code (or run /mcp) to pick up the change');

  return { ok: true, manual: false, path: target.path, wrote: true, changed: merged.changed };
}

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function mcpInstallCommand(args: string[]): Promise<void> {
  const client = parseArg(args, '--client');
  const urlOverride = parseArg(args, '--url');
  const dryRun = args.includes('--dry-run');

  if (!client) {
    console.error('usage: astramem-local mcp install --client claude|claude-code|cursor|windsurf|vscode [--url URL] [--dry-run]');
    process.exit(1);
    return;
  }

  const result = runMcpInstall({ client, urlOverride, dryRun });
  if (!result.ok) {
    process.exit(1);
  }
}
