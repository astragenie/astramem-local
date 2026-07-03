/**
 * reinstall.ts — `astramem-local reinstall` (D4).
 *
 * The one command that always works: fully non-interactive, idempotent, every
 * failure surfaced verbatim. Run it after every upgrade (git pull + build) or
 * whenever the service is in a weird state.
 *
 * Sequence:
 *   1. resolve current build (refuse if dist/ missing)
 *   2. resolve runtime config + print provenance of each value
 *   3. stop any running daemon (via daemon.lock PID)
 *   4. write shim + register scheduler task (single shared install path)
 *   5. start the service
 *   6. wait for /health, assert served version === this build's version
 *      (catches a stale global install shadowing the repo build)
 *   7. config sanity warnings (legacy dirs, plaintext backups, dataDir drift)
 *
 * Exit codes: 0 = healthy end-state; 1 = any step failed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { legacyDataDir, legacyConfigDir } from '../config/datadir.js';
import { installServiceFlow } from '../service/install-flow.js';
import { readLockInfo } from '../service/instance-lock.js';
import { waitForHealth } from './wait-health.js';
import { PKG_VERSION } from '../server/lib/wire-meta.js';

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

interface StepResult {
  step: string;
  ok: boolean;
  detail?: string;
}

async function stopRunningDaemon(dataDir: string, port: number): Promise<StepResult> {
  const holder = readLockInfo(dataDir);
  if (!holder) return { step: 'stop-daemon', ok: true, detail: 'no daemon.lock — nothing to stop' };

  let alive = true;
  try {
    process.kill(holder.pid, 0);
  } catch {
    alive = false;
  }
  if (!alive) return { step: 'stop-daemon', ok: true, detail: `stale lock (pid ${holder.pid} dead)` };

  try {
    // SIGTERM runs the daemon's graceful shutdown; on Windows Node this
    // terminates the process (no handler runs), which is still acceptable —
    // boot job-recovery handles interrupted work.
    process.kill(holder.pid, 'SIGTERM');
  } catch (err) {
    return { step: 'stop-daemon', ok: false, detail: `kill pid ${holder.pid} failed: ${(err as Error).message}` };
  }

  // Wait up to 5s for the port to go quiet.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${holder.port ?? port}/health`, { signal: AbortSignal.timeout(500) });
      await new Promise(r => setTimeout(r, 250));
    } catch {
      return { step: 'stop-daemon', ok: true, detail: `stopped pid ${holder.pid}` };
    }
  }
  return { step: 'stop-daemon', ok: false, detail: `pid ${holder.pid} still serving after 5s` };
}

export async function reinstallCommand(args: string[]): Promise<void> {
  const jsonMode = hasFlag(args, '--json');
  const steps: StepResult[] = [];
  const log = (s: string) => { if (!jsonMode) console.log(s); };

  log(`\nAstraMemory reinstall — v${PKG_VERSION}\n`);

  // 1+2. Resolve config with provenance.
  const { port, dataDir, configDir, sources } = resolveRuntimeConfig();
  log(`  config dir : ${configDir}`);
  log(`  data dir   : ${dataDir}  (from ${sources.dataDir})`);
  log(`  port       : ${port}  (from ${sources.port})`);
  steps.push({ step: 'resolve-config', ok: true, detail: `dataDir=${dataDir} port=${port}` });

  // 3. Stop any running daemon.
  const stopResult = await stopRunningDaemon(dataDir, port);
  steps.push(stopResult);
  log(`  · stop daemon: ${stopResult.detail}`);
  if (!stopResult.ok) {
    finish(steps, jsonMode);
    return;
  }

  // 4. Install (shared flow: shim + scheduler registration).
  let startFn: (() => Promise<void>) | null = null;
  try {
    const { result, adapter } = await installServiceFlow(port);
    if (result.kind === 'task') {
      steps.push({ step: 'install-service', ok: true, detail: 'registered (task)' });
      log('  · service registered (task)');
      startFn = () => adapter.start();
    } else {
      // Startup-shortcut fallback: works at next logon but no start/stop
      // control. Count it as a soft failure so the exit code says "not fully
      // healthy" — the verbatim tier errors were already printed by install.
      steps.push({
        step: 'install-service',
        ok: false,
        detail: `fell back to Startup shortcut (${result.path}) — 'service start/stop' unavailable; fix the schtasks errors above`,
      });
    }
  } catch (err) {
    steps.push({ step: 'install-service', ok: false, detail: (err as Error).message });
    log(`  ✗ install failed: ${(err as Error).message}`);
    finish(steps, jsonMode);
    return;
  }

  // 5. Start.
  if (startFn) {
    try {
      await startFn();
      steps.push({ step: 'start-service', ok: true });
      log('  · service started');
    } catch (err) {
      steps.push({ step: 'start-service', ok: false, detail: (err as Error).message });
      log(`  ✗ start failed: ${(err as Error).message}`);
    }
  }

  // 6. Health + version assertion.
  const healthy = await waitForHealth(port, 30_000);
  if (!healthy) {
    steps.push({ step: 'verify-health', ok: false, detail: `/health not responding on port ${port} within 30s` });
  } else {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json()) as { version?: string };
      if (body.version === PKG_VERSION) {
        steps.push({ step: 'verify-version', ok: true, detail: `daemon serving v${body.version}` });
        log(`  ✓ daemon healthy, serving v${body.version}`);
      } else {
        steps.push({
          step: 'verify-version',
          ok: false,
          detail:
            `daemon reports v${body.version} but this build is v${PKG_VERSION} — a DIFFERENT install is serving. ` +
            `Most common cause: a stale global install (e.g. 'bun install -g' shadowing the repo build). ` +
            `Stop the other daemon and re-run reinstall from the build you want.`,
        });
      }
    } catch (err) {
      steps.push({ step: 'verify-version', ok: false, detail: (err as Error).message });
    }
  }

  // 7. Sanity warnings (never fail the run — informational).
  const warnings: string[] = [];
  const legacyData = legacyDataDir();
  if (legacyData !== dataDir && existsSync(join(legacyData, 'memory.sqlite'))) {
    warnings.push(`legacy data dir still holds a database: ${legacyData} — verify it is not the one with your real data`);
  }
  const legacyCfg = legacyConfigDir();
  if (legacyCfg !== configDir && existsSync(legacyCfg)) {
    warnings.push(`legacy config dir still present: ${legacyCfg}`);
  }
  if (existsSync(join(dataDir, 'memory.sqlite.pre-encryption.bak'))) {
    warnings.push(`plaintext pre-encryption backup present: ${join(dataDir, 'memory.sqlite.pre-encryption.bak')} — delete once the encrypted DB is verified`);
  }
  if (sources.dataDir === 'config.yaml') {
    warnings.push(`dataDir comes from config.yaml and differs from the platform default — intentional? (${dataDir})`);
  }
  for (const w of warnings) log(`  ⚠ ${w}`);

  finish(steps, jsonMode, warnings);
}

function finish(steps: StepResult[], jsonMode: boolean, warnings: string[] = []): void {
  const failed = steps.filter(s => !s.ok);
  if (jsonMode) {
    console.log(JSON.stringify({ ok: failed.length === 0, version: PKG_VERSION, steps, warnings }, null, 2));
  } else {
    console.log('');
    if (failed.length === 0) {
      console.log('✓ reinstall complete — service registered, daemon healthy.');
    } else {
      console.log(`✗ reinstall finished with ${failed.length} failed step(s):`);
      for (const f of failed) console.log(`    ${f.step}: ${f.detail ?? 'failed'}`);
    }
    console.log('');
  }
  if (failed.length > 0) process.exit(1);
}
