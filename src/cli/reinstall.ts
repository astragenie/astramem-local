/**
 * reinstall.ts — `astramem-local reinstall` (D4).
 *
 * The one command that always works: fully non-interactive, idempotent, every
 * failure surfaced verbatim. Run it after every upgrade (git pull + build) or
 * whenever the service is in a weird state.
 *
 * Sequence:
 *   1. resolve runtime config + print provenance of each value
 *   2. materialize an immutable release dir (FEAT-438 SLICE-417) — BEFORE
 *      anything else is touched, so a bad build aborts without ever
 *      stopping a healthy running daemon
 *   3. stop any running daemon (via daemon.lock PID)
 *   4. write shim (pointed at the release dir, not the checkout's dist/) +
 *      register scheduler task (single shared install path)
 *   5. start the service
 *   6. wait for /health, assert served version === the release manifest's
 *      pkgversion (catches a stale global install shadowing the release, or
 *      the repoint itself misbehaving). On mismatch, restore the prior
 *      pointer (if one existed) so a future restart resumes the last
 *      known-good release instead of staying pinned to the unverified one —
 *      current.json is never left half-repointed.
 *   7. config sanity warnings (legacy dirs, plaintext backups, dataDir drift)
 *
 * Exit codes: 0 = healthy end-state; 1 = any step failed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { legacyDataDir, legacyConfigDir } from '../config/datadir.js';
import { installServiceFlow } from '../service/install-flow.js';
import { readLockInfo } from '../service/instance-lock.js';
import { waitForHealth } from './wait-health.js';
import { PKG_VERSION } from '../server/lib/wire-meta.js';
import { materializeRelease } from '../service/release.js';
import { shimPaths, writePointer, type ShimPointer } from '../service/shim.js';

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Restore the prior shim pointer after a post-repoint failure (AC-2).
 * `reinstallCommand` calls this from EVERY failure branch that can occur
 * after the daemon has been stopped and current.json repointed at the new
 * (unproven) release: install-service throw, start-service throw, the
 * health-check timeout, and a served-version mismatch. Without this, any of
 * those branches would leave current.json pinned to a broken release that
 * the PT5M keepalive then restarts forever — the exact silent-daemon-down
 * outage class this command exists to close (FEAT-438 SLICE-417 review
 * HIGH finding).
 *
 * Windows-only: the pointer indirection (current.json under
 * %LOCALAPPDATA%\Astramem\bin) only exists on win32 (see shim.ts /
 * install-flow.ts's `adapter.platform === 'win32'` guard) — on other
 * platforms there is nothing to roll back, so say so plainly instead of
 * implying a restore was attempted and simply found nothing.
 */
export function restorePriorPointer(
  priorPointer: ShimPointer | null,
  pointerPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') {
    return 'no rollback pointer on this platform (current.json indirection is Windows-only)';
  }
  if (!priorPointer) {
    return 'no prior pointer to restore (first install or unreadable current.json)';
  }
  try {
    writePointer(priorPointer, pointerPath);
    return `prior pointer restored → ${priorPointer.entryJs}`;
  } catch (restoreErr) {
    return `prior-pointer restore FAILED: ${(restoreErr as Error).message} — current.json may still point at the unverified release, fix manually`;
  }
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

  // 2. Materialize an immutable release (FEAT-438 SLICE-417). Deliberately
  // BEFORE the running daemon (if any) is stopped — a failed materialize
  // (bad build, native-module install failure, boot-verify mismatch) aborts
  // here and never interrupts a healthy install.
  let releaseDir: string;
  let releaseManifest: ReturnType<typeof materializeRelease>['manifest'];
  try {
    const release = materializeRelease();
    releaseDir = release.releaseDir;
    releaseManifest = release.manifest;
    steps.push({ step: 'materialize-release', ok: true, detail: `${releaseManifest.id} → ${releaseDir}` });
    log(`  · release materialized: ${releaseManifest.id}`);
  } catch (err) {
    steps.push({ step: 'materialize-release', ok: false, detail: (err as Error).message });
    log(`  ✗ materialize-release failed: ${(err as Error).message}`);
    finish(steps, jsonMode);
    return;
  }
  const releaseEntryJs = join(releaseDir, 'dist', 'cli', 'index.js');

  // Capture the prior shim pointer (Windows only — current.json lives under
  // %LOCALAPPDATA%\Astramem\bin) so a post-start served-version mismatch can
  // restore it (AC-2) instead of leaving current.json pointed at a release
  // that never proved itself. Best-effort: a missing/corrupt prior pointer
  // just means there is nothing sane to roll back to (e.g. first install).
  const pointerPath = shimPaths().pointerPath;
  let priorPointer: ShimPointer | null = null;
  if (existsSync(pointerPath)) {
    try {
      priorPointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as ShimPointer;
    } catch {
      priorPointer = null;
    }
  }

  // Memoized so every post-repoint failure branch can call this unconditionally
  // without risking a second writePointer() once one branch has already
  // restored (e.g. start-service throws, then the health-check also times out).
  let pointerRestoreDetail: string | null = null;
  const restoreOnce = (): string => {
    if (pointerRestoreDetail === null) {
      pointerRestoreDetail = restorePriorPointer(priorPointer, pointerPath);
    }
    return pointerRestoreDetail;
  };

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
    const { result, adapter, build } = await installServiceFlow(port, { entryJsOverride: releaseEntryJs });
    if (result.kind === 'task') {
      steps.push({ step: 'install-service', ok: true, detail: 'registered (task)' });
      log('  · service registered (task)');
      startFn = () => adapter.start();
      // W2.4: nightly verified backup by default — a memory daemon without
      // backups is one disk hiccup away from losing everything.
      if (!hasFlag(args, '--no-backup-timer')) {
        try {
          await adapter.installBackupTimer(build.rawExecPath, 7);
          steps.push({ step: 'install-backup-timer', ok: true, detail: 'nightly 03:00, keep 7, verified' });
          log('  · backup timer registered (nightly 03:00, keep 7)');
        } catch (err) {
          // Soft-fail: daemon service matters more than the timer.
          steps.push({ step: 'install-backup-timer', ok: false, detail: (err as Error).message });
          log(`  ⚠ backup timer failed: ${(err as Error).message}`);
        }
      }
    } else {
      // Startup-shortcut fallback: works at next logon but no start/stop
      // control. Count it as a soft failure so the exit code says "not fully
      // healthy" — the verbatim tier errors were already printed by install.
      // Restore the prior pointer explicitly (not just via the downstream
      // health-check catch): if a pre-existing keepalive task survives the failed
      // re-registration and fires inside the 30s health window, we must not leave
      // current.json pinned at the unverified release.
      const restoreDetail = restoreOnce();
      steps.push({
        step: 'install-service',
        ok: false,
        detail: `fell back to Startup shortcut (${result.path}) — 'service start/stop' unavailable; fix the schtasks errors above — repoint aborted (${restoreDetail})`,
      });
    }
  } catch (err) {
    const restoreDetail = restoreOnce();
    const detail = `${(err as Error).message} — repoint aborted (${restoreDetail})`;
    steps.push({ step: 'install-service', ok: false, detail });
    log(`  ✗ install failed: ${detail}`);
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
      const restoreDetail = restoreOnce();
      const detail = `${(err as Error).message} — repoint aborted (${restoreDetail})`;
      steps.push({ step: 'start-service', ok: false, detail });
      log(`  ✗ start failed: ${detail}`);
    }
  }

  // 6. Health + version assertion.
  const healthy = await waitForHealth(port, 30_000);
  if (!healthy) {
    const restoreDetail = restoreOnce();
    steps.push({
      step: 'verify-health',
      ok: false,
      detail: `/health not responding on port ${port} within 30s — repoint aborted (${restoreDetail})`,
    });
  } else {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json()) as { version?: string };
      if (body.version === releaseManifest.pkgversion) {
        steps.push({
          step: 'verify-version',
          ok: true,
          detail: `daemon serving v${body.version} (release ${releaseManifest.id})`,
        });
        log(`  ✓ daemon healthy, serving v${body.version} (release ${releaseManifest.id})`);
      } else {
        // Served version doesn't match the release we just pointed at — do
        // NOT leave current.json pinned to an unverified release (AC-2).
        // Restore the prior pointer (if one existed) so the NEXT boot/
        // keepalive restart resumes the last known-good release; this repoint
        // is reported as failed regardless.
        const restoreDetail = restoreOnce();
        steps.push({
          step: 'verify-version',
          ok: false,
          detail:
            `daemon reports v${body.version} but the materialized release ${releaseManifest.id} expects v${releaseManifest.pkgversion} — ` +
            `repoint aborted (${restoreDetail}). Most common cause: a stale global install (e.g. 'bun install -g') shadowing this port, ` +
            `or a corrupted release dir at ${releaseDir}. Investigate before re-running reinstall.`,
        });
      }
    } catch (err) {
      const restoreDetail = restoreOnce();
      steps.push({
        step: 'verify-version',
        ok: false,
        detail: `${(err as Error).message} — repoint aborted (${restoreDetail})`,
      });
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
