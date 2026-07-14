import { existsSync } from 'node:fs';
import { win32, posix } from 'node:path';
import { platform } from 'node:os';
import type { Check, CheckResult } from '../types.js';

const BIN_NAME = 'astramem-local';

/**
 * Candidate filenames for the CLI binary on a given platform, in shell
 * resolution order. Windows shells match PATHEXT-listed extensions
 * (.exe/.cmd/.bat are directly invocable without typing the extension);
 * POSIX shells match the bare name only.
 */
function candidateNames(platformId: NodeJS.Platform): string[] {
  if (platformId === 'win32') {
    return [`${BIN_NAME}.exe`, `${BIN_NAME}.cmd`, `${BIN_NAME}.bat`, BIN_NAME];
  }
  return [BIN_NAME];
}

export interface PathShadowOverrides {
  /** Raw PATH string to scan. Defaults to `process.env.PATH ?? ''`. Injectable for deterministic tests. */
  path?: string;
  /** PATH entry separator. Defaults to ';' on win32, ':' elsewhere. Injectable for deterministic tests. */
  separator?: string;
  /** Platform id, used only to pick candidate filenames. Defaults to `os.platform()`. */
  platformId?: NodeJS.Platform;
  /** Per-candidate existence check. Defaults to `fs.existsSync`. Injectable so tests never touch the real filesystem. */
  exists?: (candidatePath: string) => boolean;
}

// ─── Check: PATH binary shadow (issue #308) ───────────────────────────────────

/**
 * Warns when MORE THAN ONE `astramem-local` executable is reachable on PATH.
 *
 * Issue #308: a stale bun-global install (`~/.bun/bin/astramem-local`, an old
 * 0.4.0 build) shadowed the current npm-global install (0.18.0) whenever
 * `~/.bun/bin` preceded the npm bin dir on PATH. The shell silently resolved
 * the old binary — which predates the `reinstall` command — so the operator
 * saw `unknown command: reinstall` with no hint that a newer, working install
 * existed elsewhere on the same machine. This check makes that shape visible
 * before it costs someone a debugging session.
 *
 * Detection + guidance only: it never deletes or modifies a binary, and it
 * always WARNs (`ok: false`) rather than treating a second install as a hard
 * failure — a stray PATH entry is a footgun, not broken state, matching the
 * same non-fatal WARN convention as `checkConfigDirDivergence` and
 * `checkProxyCaptureReminder` in this same checks/ directory.
 *
 * Both PATH and the per-directory existence probe are injectable (see
 * `PathShadowOverrides`) so tests are deterministic and independent of the
 * runner's real PATH/filesystem — no real binaries are ever touched or
 * required to exist.
 */
export function checkPathShadow(overrides: PathShadowOverrides = {}): Check {
  return {
    name: 'PATH binary shadow',
    tier: 'cheap', // a bounded number of fs existence checks over PATH entries
    async run(): Promise<CheckResult> {
      const platformId = overrides.platformId ?? platform();
      const rawPath = overrides.path ?? process.env.PATH ?? '';
      const separator = overrides.separator ?? (platformId === 'win32' ? ';' : ':');
      const exists = overrides.exists ?? existsSync;
      const names = candidateNames(platformId);
      // Platform-explicit join (not the host-native `node:path` default) so
      // behavior is deterministic under test regardless of which OS the
      // test runner itself is on — a win32 dev box must still be able to
      // exercise the posix join shape, and vice versa.
      const joinPath = platformId === 'win32' ? win32.join : posix.join;

      const dirs = rawPath
        .split(separator)
        .map(d => d.trim())
        .filter(d => d.length > 0);

      const found: string[] = [];
      for (const dir of dirs) {
        for (const name of names) {
          const candidate = joinPath(dir, name);
          if (exists(candidate)) {
            found.push(candidate);
            break; // one match per PATH dir — don't double-count .exe + .cmd in the same dir
          }
        }
      }

      if (found.length <= 1) {
        return {
          ok: true,
          message:
            found.length === 1
              ? `PATH binary shadow: single ${BIN_NAME} on PATH (${found[0]})`
              : `PATH binary shadow: no ${BIN_NAME} found on PATH`,
        };
      }

      return {
        ok: false,
        message:
          `${found.length} ${BIN_NAME} binaries found on PATH — the shell resolves "${found[0]}" ` +
          `(first match wins). All: ${found.join(', ')}`,
        fix:
          `Remove or reorder the stale install(s) so only one ${BIN_NAME} remains on PATH ` +
          `(check with "where ${BIN_NAME}" on Windows or "which -a ${BIN_NAME}" on macOS/Linux), ` +
          `or invoke the intended one by its full path.`,
      };
    },
  };
}
