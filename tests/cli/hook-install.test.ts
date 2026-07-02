/**
 * tests/cli/hook-install.test.ts
 *
 * Unit coverage for the SessionStart memory-pack hook auto-install
 * (src/cli/hook-install.ts, init wizard 2f / KF-B follow-up).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import {
  buildHookCommand,
  installMemoryPackHook,
  defaultSettingsPath,
  HOOK_MARKER,
} from '../../src/cli/hook-install.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `astra-hook-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('buildHookCommand', () => {
  it('embeds the daemon port and the /recall/pack marker', () => {
    const cmd = buildHookCommand(17781);
    expect(cmd).toContain('http://127.0.0.1:17781/recall/pack');
    expect(cmd).toContain(HOOK_MARKER);
  });

  it('references MEMORY_BEARER (not the stale ASTRAMEM_TOKEN doc placeholder)', () => {
    const cmd = buildHookCommand(7777);
    expect(cmd).toContain('MEMORY_BEARER');
    expect(cmd).not.toContain('ASTRAMEM_TOKEN');
  });

  it('uses the platform-appropriate variant', () => {
    const cmd = buildHookCommand(7777);
    if (platform() === 'win32') {
      expect(cmd).toMatch(/^powershell -NoProfile/);
      expect(cmd).toContain('Invoke-RestMethod');
    } else {
      expect(cmd).toMatch(/^curl -s -m 2/);
    }
  });
});

describe('installMemoryPackHook', () => {
  it('writes the hook into a fresh settings.json', () => {
    const dir = makeTmpDir();
    const settingsPath = join(dir, 'settings.json');

    const result = installMemoryPackHook({ port: 17782, settingsPath });

    expect(result.outcome).toBe('installed');
    expect(existsSync(settingsPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    const cmd = parsed.hooks.SessionStart[0].hooks[0].command as string;
    expect(cmd).toContain('17782');
    expect(cmd).toContain(HOOK_MARKER);
    expect(parsed.hooks.SessionStart[0].hooks[0].timeout).toBe(3);
  });

  it('creates parent directories that do not yet exist', () => {
    const dir = makeTmpDir();
    const settingsPath = join(dir, 'nested', 'deeper', 'settings.json');

    const result = installMemoryPackHook({ port: 7777, settingsPath });

    expect(result.outcome).toBe('installed');
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('is idempotent — second call detects the marker and skips', () => {
    const dir = makeTmpDir();
    const settingsPath = join(dir, 'settings.json');

    const first = installMemoryPackHook({ port: 7777, settingsPath });
    const before = readFileSync(settingsPath, 'utf8');
    const second = installMemoryPackHook({ port: 7777, settingsPath });
    const after = readFileSync(settingsPath, 'utf8');

    expect(first.outcome).toBe('installed');
    expect(second.outcome).toBe('already-installed');
    expect(after).toBe(before); // no duplicate hook block appended

    const parsed = JSON.parse(after);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
  });

  it('preserves existing unrelated settings.json content and hooks', () => {
    const dir = makeTmpDir();
    const settingsPath = join(dir, 'settings.json');
    const existing = {
      theme: 'dark',
      permissions: { allow: ['Bash(git *)'] },
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo pre', timeout: 1 }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo unrelated-existing', timeout: 2 }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

    const result = installMemoryPackHook({ port: 7777, settingsPath });
    expect(result.outcome).toBe('installed');

    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(parsed.theme).toBe('dark');
    expect(parsed.permissions.allow).toEqual(['Bash(git *)']);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('echo pre');
    // Original unrelated SessionStart block preserved, astramem block appended alongside it.
    expect(parsed.hooks.SessionStart).toHaveLength(2);
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe('echo unrelated-existing');
    const astramemBlock = parsed.hooks.SessionStart.find((b: { hooks: { command: string }[] }) =>
      b.hooks.some((h) => h.command.includes(HOOK_MARKER))
    );
    expect(astramemBlock).toBeDefined();
  });

  it('throws an actionable error on invalid existing JSON', () => {
    const dir = makeTmpDir();
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, '{ not valid json');

    expect(() => installMemoryPackHook({ port: 7777, settingsPath })).toThrow(/invalid JSON/);
  });

  it('defaultSettingsPath resolves under ~/.claude/settings.json', () => {
    expect(defaultSettingsPath()).toContain('.claude');
    expect(defaultSettingsPath()).toContain('settings.json');
  });
});
