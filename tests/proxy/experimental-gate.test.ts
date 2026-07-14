/**
 * Release no-go hard gate (src/cli/proxy.ts): `astramem-local proxy serve`
 * refuses to start the listener at all unless `proxy.experimental` is
 * explicitly `true` in config.yaml — proxy.enabled is NOT a start gate for
 * this subcommand (see that file's module doc comment), so this is the ONE
 * check standing between an operator and a running proxy process.
 *
 * Spawns the real built CLI (dist/cli/index.js), same pattern as
 * tests/proxy/loopback-refusal.test.ts, so this exercises the actual
 * argv-parsing + config-resolution + process.exitCode path a user hits, not
 * just proxyCommand() called in isolation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/config.js';
import { configToYaml } from '../../src/config/writer.js';

function runCli(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn('node', ['dist/cli/index.js', ...args], {
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('exit', (code) => resolve({ stdout, stderr, code }));
  });
}

const GATE_MESSAGE =
  'proxy: the LLM proxy is EXPERIMENTAL and not enabled for this release — set proxy.experimental: true in config.yaml to opt in.';

describe('proxy serve — experimental hard gate (release no-go)', () => {
  it('refuses to start with the shipped default (proxy.experimental: false) — loud message, exit 1, no listener', async () => {
    const { stdout, stderr, code } = await runCli(
      ['proxy', 'serve', '--port', '0', '--upstream', 'http://127.0.0.1:1'],
      { ASTRA_MEMORY_ISOLATED: '1' },
    );
    expect(stderr).toContain(GATE_MESSAGE);
    expect(code).toBe(1);
    expect(stdout).not.toContain('proxy serving on');
  }, 15_000);

  it('refuses even with a valid loopback host/upstream — experimental is checked, not bypassed by other flags', async () => {
    const { stderr, code } = await runCli(
      ['proxy', 'serve', '--host', '127.0.0.1', '--port', '0', '--upstream', 'https://api.openai.com/v1'],
      { ASTRA_MEMORY_ISOLATED: '1' },
    );
    expect(stderr).toContain(GATE_MESSAGE);
    expect(code).toBe(1);
  }, 15_000);

  describe('with proxy.experimental: true in config.yaml', () => {
    let configParent: string;
    let dataDir: string;
    let proc: ChildProcess | undefined;

    afterEach(() => {
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGTERM');
      }
      if (configParent) rmSync(configParent, { recursive: true, force: true });
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    });

    it('starts the listener once opted in via config.yaml', async () => {
      // Sandbox the config dir the daemon resolves config.yaml from on EVERY
      // platform, plus the datadir. `defaultConfigDir()` (src/config/datadir.ts)
      // is platform-specific — %APPDATA%\Astramem on win32 but
      // $XDG_CONFIG_HOME/astra-memory (~/.config/astra-memory) on linux/darwin.
      // The CI runner is Linux; redirecting only APPDATA leaves the CLI reading
      // the REAL operator config there (no proxy.experimental), so the gate
      // fires and this test fails only on CI. Write the config under BOTH dir
      // names and redirect APPDATA/LOCALAPPDATA + XDG_CONFIG_HOME/XDG_DATA_HOME/
      // HOME so whichever resolver the runner's OS uses lands in the sandbox.
      configParent = mkdtempSync(join(tmpdir(), 'astramem-proxy-gate-cfg-'));
      dataDir = mkdtempSync(join(tmpdir(), 'astramem-proxy-gate-data-'));

      const cfg = defaultConfig();
      cfg.proxy.experimental = true;
      const yaml = configToYaml(cfg);
      for (const dirName of ['Astramem', 'astra-memory']) {
        const configDir = join(configParent, dirName);
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, 'config.yaml'), yaml, 'utf8');
      }

      proc = spawn('node', ['dist/cli/index.js', 'proxy', 'serve', '--host', '127.0.0.1', '--port', '0', '--upstream', 'http://127.0.0.1:1'], {
        env: {
          ...process.env,
          // win32: %APPDATA%\Astramem — also LOCALAPPDATA because
          // migrateLegacyDirsIfPresent() (src/config/migrate-dirs.ts) runs on
          // every non-isolated boot and reads LOCALAPPDATA directly.
          APPDATA: configParent,
          LOCALAPPDATA: configParent,
          // linux/darwin: $XDG_CONFIG_HOME/astra-memory + HOME fallback for the
          // ~/.config resolver when XDG is unset. XDG_DATA_HOME sandboxes the
          // data dir the same way ASTRA_MEMORY_DATADIR does, belt-and-suspenders.
          XDG_CONFIG_HOME: configParent,
          XDG_DATA_HOME: dataDir,
          HOME: configParent,
          ASTRA_MEMORY_DATADIR: dataDir,
        },
        stdio: 'pipe',
      });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !stdout.includes('proxy serving on') && proc.exitCode === null) {
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(stderr).not.toContain('EXPERIMENTAL');
      expect(stdout).toContain('proxy serving on');
    }, 15_000);
  });
});
