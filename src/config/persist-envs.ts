/**
 * Cross-platform persistence of environment variables for the user's shell.
 *
 * Windows: SetEnvironmentVariable(key, value, "User") via spawned PowerShell.
 *          Equivalent to `setx KEY VAL` but doesn't truncate at 1024 chars.
 *
 * Linux/macOS: append/replace an idempotent block to the user's shell rc:
 *   - bash → ~/.bashrc
 *   - zsh  → ~/.zshrc
 *   - fish → ~/.config/fish/config.fish
 *   Defaults to ~/.profile if shell can't be detected.
 *
 * The block is wrapped in begin/end markers so re-running init does not
 * accumulate duplicate exports.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const MARKER_BEGIN = '# >>> astra-memory env >>>';
const MARKER_END = '# <<< astra-memory env <<<';

export interface PersistResult {
  ok: boolean;
  target: string;
  message: string;
  /** True when the caller likely needs to open a new shell for envs to take effect. */
  requiresNewShell: boolean;
}

export async function persistEnvVars(vars: Record<string, string>): Promise<PersistResult> {
  if (platform() === 'win32') return persistWindows(vars);
  return persistUnix(vars);
}

// ─── Windows ─────────────────────────────────────────────────────────────────

function persistWindows(vars: Record<string, string>): PersistResult {
  // Use [Environment]::SetEnvironmentVariable so values longer than 1024 chars
  // are accepted (setx truncates).
  //
  // PowerShell quoting strategy: build the script with SINGLE-quoted string
  // literals so embedded double-quotes do not collide with the outer
  // `powershell -Command "..."` shell quoting. Single-quoted PS strings do
  // not expand $vars or backticks — values pass through literally. Escape
  // embedded single quotes by doubling them (PS rule).
  const ps = Object.entries(vars)
    .map(([k, v]) => {
      const esc = v.replace(/'/g, "''");
      return `[Environment]::SetEnvironmentVariable('${k}', '${esc}', 'User')`;
    })
    .join('; ');

  try {
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: 'pipe', timeout: 10_000 });
    return {
      ok: true,
      target: 'Windows User environment',
      message: `Wrote ${Object.keys(vars).length} env var(s) to User scope`,
      requiresNewShell: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      target: 'Windows User environment',
      message: `Failed: ${msg.slice(0, 200)}`,
      requiresNewShell: false,
    };
  }
}

// ─── Unix (Linux + macOS) ────────────────────────────────────────────────────

function detectRcPath(): { path: string; shell: string } {
  const shell = process.env['SHELL'] ?? '';
  const home = homedir();
  if (shell.includes('zsh')) return { path: join(home, '.zshrc'), shell: 'zsh' };
  if (shell.includes('fish')) return { path: join(home, '.config', 'fish', 'config.fish'), shell: 'fish' };
  if (shell.includes('bash')) return { path: join(home, '.bashrc'), shell: 'bash' };
  return { path: join(home, '.profile'), shell: 'sh' };
}

function buildExportBlock(vars: Record<string, string>, shell: string): string {
  const lines = [MARKER_BEGIN];
  for (const [k, v] of Object.entries(vars)) {
    if (shell === 'fish') {
      // single-quoted on fish too — fish doesn't expand inside single quotes
      lines.push(`set -gx ${k} '${v.replace(/'/g, "'\\''")}'`);
    } else {
      // POSIX shells — single-quote to avoid expansion of $ etc.
      lines.push(`export ${k}='${v.replace(/'/g, "'\\''")}'`);
    }
  }
  lines.push(MARKER_END);
  return lines.join('\n');
}

function persistUnix(vars: Record<string, string>): PersistResult {
  const { path, shell } = detectRcPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const block = buildExportBlock(vars, shell);

    // Replace if the markers exist; otherwise append.
    const re = new RegExp(`${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}`, 'm');
    const next = re.test(existing)
      ? existing.replace(re, block)
      : (existing.endsWith('\n') || existing === '' ? existing : existing + '\n') + '\n' + block + '\n';

    writeFileSync(path, next, 'utf8');
    return {
      ok: true,
      target: path,
      message: `Wrote ${Object.keys(vars).length} env var(s) to ${shell} rc`,
      requiresNewShell: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      target: path,
      message: `Failed: ${msg.slice(0, 200)}`,
      requiresNewShell: false,
    };
  }
}
