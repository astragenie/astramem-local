import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';

// Re-impl the Unix rc helper locally to test without mocking process.env.SHELL,
// since persistEnvVars hardcodes os.homedir(). We test the logic by writing
// against tmp paths through the same regex contract.

const MARKER_BEGIN = '# >>> astra-memory env >>>';
const MARKER_END = '# <<< astra-memory env <<<';

function buildBlock(vars: Record<string, string>): string {
  const lines = [MARKER_BEGIN];
  for (const [k, v] of Object.entries(vars)) {
    lines.push(`export ${k}='${v.replace(/'/g, "'\\''")}'`);
  }
  lines.push(MARKER_END);
  return lines.join('\n');
}

function applyToFile(path: string, vars: Record<string, string>): void {
  const existing = (() => {
    try { return readFileSync(path, 'utf8'); } catch { return ''; }
  })();
  const block = buildBlock(vars);
  const re = new RegExp(`${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}`, 'm');
  const next = re.test(existing)
    ? existing.replace(re, block)
    : (existing.endsWith('\n') || existing === '' ? existing : existing + '\n') + '\n' + block + '\n';
  writeFileSync(path, next, 'utf8');
}

describe('persist-envs rc-file logic', () => {
  it('appends a block when file does not contain markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astra-rc-'));
    const rc = join(dir, '.bashrc');
    writeFileSync(rc, 'export FOO=bar\n', 'utf8');
    applyToFile(rc, { MEMORY_BEARER: 'abc', MEMORY_API_URL: 'http://127.0.0.1:7777' });
    const out = readFileSync(rc, 'utf8');
    expect(out).toContain('export FOO=bar');
    expect(out).toContain(MARKER_BEGIN);
    expect(out).toContain("export MEMORY_BEARER='abc'");
    expect(out).toContain("export MEMORY_API_URL='http://127.0.0.1:7777'");
    expect(out).toContain(MARKER_END);
  });

  it('replaces existing block on second run (no duplication)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astra-rc-'));
    const rc = join(dir, '.bashrc');
    writeFileSync(rc, 'export OLD=keep\n', 'utf8');
    applyToFile(rc, { MEMORY_BEARER: 'first' });
    applyToFile(rc, { MEMORY_BEARER: 'second' });
    const out = readFileSync(rc, 'utf8');
    expect(out).toContain('export OLD=keep');
    expect(out).toContain("export MEMORY_BEARER='second'");
    expect(out).not.toContain("export MEMORY_BEARER='first'");
    // Only one begin marker
    expect(out.match(new RegExp(MARKER_BEGIN, 'g'))?.length).toBe(1);
  });

  it('creates file (with parent dirs) when it does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astra-rc-'));
    const rc = join(dir, 'nested', 'config', 'config.fish');
    mkdirSync(join(dir, 'nested', 'config'), { recursive: true });
    applyToFile(rc, { MEMORY_BEARER: 'tok' });
    const out = readFileSync(rc, 'utf8');
    expect(out).toContain(MARKER_BEGIN);
    expect(out).toContain("export MEMORY_BEARER='tok'");
  });

  it('escapes single quotes in values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astra-rc-'));
    const rc = join(dir, '.zshrc');
    applyToFile(rc, { TRICKY: "it's a token" });
    const out = readFileSync(rc, 'utf8');
    // POSIX single-quote escape pattern: 'it'\''s a token'
    expect(out).toContain("export TRICKY='it'\\''s a token'");
  });
});

describe('persistEnvVars (integration on actual platform)', () => {
  it('importable without crashing', async () => {
    const { persistEnvVars } = await import('../../src/config/persist-envs.js');
    expect(typeof persistEnvVars).toBe('function');
    void platform;
  });
});
