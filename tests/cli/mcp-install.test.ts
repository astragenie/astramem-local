/**
 * tests/cli/mcp-install.test.ts
 *
 * Exercises the config-writer logic behind `astramem-local mcp install`
 * against fixture directories — never the real `~/.cursor/mcp.json` or
 * `claude_desktop_config.json` paths. Covers: pure JSON-merge idempotency
 * (`mergeServersJson`), the full `runMcpInstall` flow (write, backup,
 * dry-run, re-run idempotency, malformed-existing-file refusal), and the
 * manual-instructions path for clients we don't write to.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMcpEntry,
  mergeServersJson,
  resolveClientTarget,
  claudeDesktopConfigPath,
  isImplementedClient,
  isManualClient,
  runMcpInstall,
} from '../../src/cli/mcp-install.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'astra-mcp-install-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── pure helpers ────────────────────────────────────────────────────────

describe('buildMcpEntry', () => {
  it('builds an http-type entry with a Bearer header', () => {
    expect(buildMcpEntry('http://127.0.0.1:7777/mcp', 'tok123')).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:7777/mcp',
      headers: { Authorization: 'Bearer tok123' },
    });
  });
});

describe('isImplementedClient / isManualClient', () => {
  it('classifies the five known clients correctly', () => {
    expect(isImplementedClient('claude')).toBe(true);
    expect(isImplementedClient('claude-code')).toBe(true);
    expect(isImplementedClient('cursor')).toBe(true);
    expect(isImplementedClient('windsurf')).toBe(false);
    expect(isManualClient('windsurf')).toBe(true);
    expect(isManualClient('vscode')).toBe(true);
    expect(isManualClient('cursor')).toBe(false);
  });

  it('rejects an unknown client name on both predicates', () => {
    expect(isImplementedClient('notepad')).toBe(false);
    expect(isManualClient('notepad')).toBe(false);
  });
});

describe('resolveClientTarget', () => {
  it('claude-code targets <cwd>/.mcp.json', () => {
    const target = resolveClientTarget('claude-code', { cwd: dir });
    expect(target.path).toBe(join(dir, '.mcp.json'));
    expect(target.serversKey).toBe('mcpServers');
    expect(target.entryKey).toBe('astramem-local');
  });

  it('cursor targets <home>/.cursor/mcp.json', () => {
    const target = resolveClientTarget('cursor', { homeDir: dir });
    expect(target.path).toBe(join(dir, '.cursor', 'mcp.json'));
  });

  it('claude targets the per-OS Claude Desktop config path', () => {
    const target = resolveClientTarget('claude', { homeDir: dir, env: {}, plat: 'darwin' });
    expect(target.path).toBe(join(dir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  });
});

describe('claudeDesktopConfigPath', () => {
  it('win32 uses APPDATA when set', () => {
    const p = claudeDesktopConfigPath({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32', 'C:\\Users\\x');
    expect(p).toBe(join('C:\\Users\\x\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
  });

  it('darwin uses ~/Library/Application Support', () => {
    expect(claudeDesktopConfigPath({}, 'darwin', '/Users/x')).toBe(
      join('/Users/x', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    );
  });

  it('linux uses XDG_CONFIG_HOME or ~/.config', () => {
    expect(claudeDesktopConfigPath({}, 'linux', '/home/x')).toBe(
      join('/home/x', '.config', 'Claude', 'claude_desktop_config.json'),
    );
    expect(claudeDesktopConfigPath({ XDG_CONFIG_HOME: '/custom/xdg' }, 'linux', '/home/x')).toBe(
      join('/custom/xdg', 'Claude', 'claude_desktop_config.json'),
    );
  });
});

describe('mergeServersJson', () => {
  const entry = { type: 'http', url: 'http://127.0.0.1:7777/mcp', headers: { Authorization: 'Bearer tok' } };

  it('creates a fresh file shape when nothing existed before', () => {
    const { text, changed } = mergeServersJson(null, 'mcpServers', 'astramem-local', entry);
    expect(changed).toBe(true);
    expect(JSON.parse(text)).toEqual({ mcpServers: { 'astramem-local': entry } });
  });

  it('is idempotent — merging the same entry twice reports unchanged on the second pass', () => {
    const first = mergeServersJson(null, 'mcpServers', 'astramem-local', entry);
    const second = mergeServersJson(first.text, 'mcpServers', 'astramem-local', entry);
    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
  });

  it('updates (not duplicates) the entry when it changes', () => {
    const first = mergeServersJson(null, 'mcpServers', 'astramem-local', entry);
    const updatedEntry = { ...entry, url: 'http://127.0.0.1:9999/mcp' };
    const second = mergeServersJson(first.text, 'mcpServers', 'astramem-local', updatedEntry);
    expect(second.changed).toBe(true);
    const parsed = JSON.parse(second.text);
    expect(Object.keys(parsed.mcpServers)).toEqual(['astramem-local']);
    expect(parsed.mcpServers['astramem-local'].url).toBe('http://127.0.0.1:9999/mcp');
  });

  it('preserves sibling keys and other mcpServers entries untouched', () => {
    const existing = JSON.stringify({
      someOtherTopLevelKey: 'keep-me',
      mcpServers: { 'another-server': { type: 'stdio', command: 'foo' } },
    });
    const { text } = mergeServersJson(existing, 'mcpServers', 'astramem-local', entry);
    const parsed = JSON.parse(text);
    expect(parsed.someOtherTopLevelKey).toBe('keep-me');
    expect(parsed.mcpServers['another-server']).toEqual({ type: 'stdio', command: 'foo' });
    expect(parsed.mcpServers['astramem-local']).toEqual(entry);
  });

  it('throws on invalid existing JSON rather than silently discarding it', () => {
    expect(() => mergeServersJson('{ not valid json', 'mcpServers', 'astramem-local', entry)).toThrow();
  });
});

// ─── full runMcpInstall flow against fixture dirs ──────────────────────────

describe('runMcpInstall — claude-code (.mcp.json)', () => {
  const resolveUrl = () => 'http://127.0.0.1:7777/mcp';
  const resolveToken = () => 'devtok';

  it('writes a new .mcp.json when none exists', () => {
    const result = runMcpInstall({
      client: 'claude-code',
      targetOpts: { cwd: dir },
      resolveUrl,
      resolveToken,
    });
    expect(result.ok).toBe(true);
    expect(result.wrote).toBe(true);
    expect(result.changed).toBe(true);
    const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(written.mcpServers['astramem-local']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:7777/mcp',
      headers: { Authorization: 'Bearer devtok' },
    });
    expect(existsSync(join(dir, '.mcp.json.bak'))).toBe(false); // nothing to back up on first write
  });

  it('is idempotent on a second run with the same inputs (no duplicate entries, changed=false)', () => {
    runMcpInstall({ client: 'claude-code', targetOpts: { cwd: dir }, resolveUrl, resolveToken });
    const second = runMcpInstall({ client: 'claude-code', targetOpts: { cwd: dir }, resolveUrl, resolveToken });
    expect(second.changed).toBe(false);
    const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(Object.keys(written.mcpServers)).toEqual(['astramem-local']);
  });

  it('backs up the existing file to .bak before overwriting, and updates in place when the url changes', () => {
    runMcpInstall({ client: 'claude-code', targetOpts: { cwd: dir }, resolveUrl, resolveToken });
    const beforeBak = readFileSync(join(dir, '.mcp.json'), 'utf8');

    const second = runMcpInstall({
      client: 'claude-code',
      targetOpts: { cwd: dir },
      resolveUrl: () => 'http://127.0.0.1:9999/mcp',
      resolveToken,
    });
    expect(second.changed).toBe(true);
    expect(existsSync(join(dir, '.mcp.json.bak'))).toBe(true);
    expect(readFileSync(join(dir, '.mcp.json.bak'), 'utf8')).toBe(beforeBak);

    const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(written.mcpServers['astramem-local'].url).toBe('http://127.0.0.1:9999/mcp');
  });

  it('preserves an existing unrelated mcpServers entry', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'some-other-tool': { type: 'stdio', command: 'x' } } }),
    );
    runMcpInstall({ client: 'claude-code', targetOpts: { cwd: dir }, resolveUrl, resolveToken });
    const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
    expect(written.mcpServers['some-other-tool']).toEqual({ type: 'stdio', command: 'x' });
    expect(written.mcpServers['astramem-local']).toBeDefined();
  });

  it('--dry-run prints the would-be contents and writes nothing', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = runMcpInstall({
      client: 'claude-code',
      dryRun: true,
      targetOpts: { cwd: dir },
      resolveUrl,
      resolveToken,
    });
    expect(result.wrote).toBe(false);
    expect(existsSync(join(dir, '.mcp.json'))).toBe(false);
    expect(logSpy.mock.calls.some(c => String(c[0]).includes('would write'))).toBe(true);
    logSpy.mockRestore();
  });

  it('refuses to clobber a malformed existing file', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.mcp.json'), '{ this is not json');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = runMcpInstall({ client: 'claude-code', targetOpts: { cwd: dir }, resolveUrl, resolveToken });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(dir, '.mcp.json'), 'utf8')).toBe('{ this is not json');
    errSpy.mockRestore();
  });
});

describe('runMcpInstall — cursor (~/.cursor/mcp.json)', () => {
  it('creates the .cursor directory and writes mcp.json', () => {
    const result = runMcpInstall({
      client: 'cursor',
      targetOpts: { homeDir: dir },
      resolveUrl: () => 'http://127.0.0.1:7777/mcp',
      resolveToken: () => 'devtok',
    });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(dir, '.cursor', 'mcp.json'));
    const written = JSON.parse(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8'));
    expect(written.mcpServers['astramem-local'].url).toBe('http://127.0.0.1:7777/mcp');
  });
});

describe('runMcpInstall — manual clients (windsurf, vscode)', () => {
  it('windsurf prints instructions and never touches the filesystem', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = runMcpInstall({
      client: 'windsurf',
      targetOpts: { cwd: dir },
      resolveUrl: () => 'http://127.0.0.1:7777/mcp',
      resolveToken: () => 'devtok',
    });
    expect(result.manual).toBe(true);
    expect(result.wrote).toBe(false);
    expect(logSpy.mock.calls.some(c => String(c[0]).includes('no automated writer'))).toBe(true);
    logSpy.mockRestore();
  });

  it('vscode prints instructions and never touches the filesystem', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = runMcpInstall({
      client: 'vscode',
      targetOpts: { cwd: dir },
      resolveUrl: () => 'http://127.0.0.1:7777/mcp',
      resolveToken: () => 'devtok',
    });
    expect(result.manual).toBe(true);
    expect(result.wrote).toBe(false);
    logSpy.mockRestore();
  });
});

describe('runMcpInstall — unknown client', () => {
  it('reports ok:false and does not write anything', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = runMcpInstall({
      client: 'notepad',
      targetOpts: { cwd: dir },
      resolveUrl: () => 'http://127.0.0.1:7777/mcp',
      resolveToken: () => 'devtok',
    });
    expect(result.ok).toBe(false);
    expect(result.wrote).toBe(false);
    errSpy.mockRestore();
  });
});
