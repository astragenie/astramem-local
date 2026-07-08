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
import { installServiceFlow, resolveBuild } from '../service/install-flow.js';
import { getServiceAdapter } from '../service/index.js';
import { readLockInfo } from '../service/instance-lock.js';
import { waitForHealth } from './wait-health.js';
import { PKG_VERSION } from '../server/lib/wire-meta.js';
import {
  materializeRelease,
  listReleases,
  pruneReleases,
  releaseIdFromEntryJs,
  defaultReleasesRoot,
  type ReleaseManifest,
  type ReleaseListEntry,
} from '../service/release.js';
import { shimPaths, writeShim, writePointer, type ShimPointer } from '../service/shim.js';

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
 * the keepalive/restart policy then restarts forever — the exact silent-
 * daemon-down outage class this command exists to close (FEAT-438 SLICE-417
 * review HIGH finding).
 *
 * Cross-platform since FEAT-443 SLICE-1: the pointer indirection (current.json
 * under `<defaultDataDir()>/bin`, see shim.ts) now exists on linux/darwin too,
 * not just win32 — install-flow.ts writes the stable shim unconditionally on
 * every platform now. The only genuinely-nothing-to-restore case left is a
 * first install / unreadable current.json (`priorPointer === null`), handled
 * below — there is no more platform gate.
 */
export function restorePriorPointer(
  priorPointer: ShimPointer | null,
  pointerPath: string,
): string {
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
  const rollback = hasFlag(args, '--rollback');
  const dev = hasFlag(args, '--dev');

  if (rollback && dev) {
    finish([{ step: 'parse-args', ok: false, detail: '--rollback and --dev are mutually exclusive' }], jsonMode);
    return;
  }
  if (rollback) {
    await reinstallRollback(jsonMode);
    return;
  }
  if (dev) {
    await reinstallDev(jsonMode);
    return;
  }

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

  // Capture the prior shim pointer (current.json lives under
  // <defaultDataDir()>/bin — see shim.ts; cross-platform since FEAT-443
  // SLICE-1) so a post-start served-version mismatch can restore it (AC-2)
  // instead of leaving current.json pointed at a release that never proved
  // itself. Best-effort: a missing/corrupt prior pointer just means there is
  // nothing sane to roll back to (e.g. first install).
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

  // 6.5. Retention (FEAT-438 SLICE-418 AC-3) — ONLY after the repoint has
  // fully proven itself (verify-version ok). If it didn't (rolled back to
  // the prior pointer above), the old releases are still the known-good
  // ones and pruning here would delete the very thing we just fell back to.
  // The just-verified release is passed as a protected id — it must never
  // be pruned even if it happens to be older than the retention window (it
  // can't be here, but protecting it is what keeps this correct if `keep`
  // is ever lowered below 1). A prune failure is a SOFT step: it is never
  // allowed to flip the overall run to failed or trigger a pointer rollback.
  const verifyVersionStep = steps.find(s => s.step === 'verify-version');
  if (verifyVersionStep?.ok) {
    try {
      const { pruned, kept } = pruneReleases(undefined, 2, [releaseManifest.id]);
      const detail = `kept ${kept.length} (${kept.join(', ')})` +
        (pruned.length > 0 ? `, pruned ${pruned.length} (${pruned.join(', ')})` : ', pruned 0');
      steps.push({ step: 'prune-releases', ok: true, detail });
      log(`  · prune-releases: ${detail}`);
    } catch (err) {
      steps.push({ step: 'prune-releases', ok: true, detail: `skipped (error: ${(err as Error).message})` });
      log(`  ⚠ prune-releases skipped: ${(err as Error).message}`);
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

function finish(
  steps: StepResult[],
  jsonMode: boolean,
  warnings: string[] = [],
  successMessage = '✓ reinstall complete — service registered, daemon healthy.',
): void {
  const failed = steps.filter(s => !s.ok);
  if (jsonMode) {
    console.log(JSON.stringify({ ok: failed.length === 0, version: PKG_VERSION, steps, warnings }, null, 2));
  } else {
    console.log('');
    if (failed.length === 0) {
      console.log(successMessage);
    } else {
      console.log(`✗ reinstall finished with ${failed.length} failed step(s):`);
      for (const f of failed) console.log(`    ${f.step}: ${f.detail ?? 'failed'}`);
    }
    console.log('');
  }
  if (failed.length > 0) process.exit(1);
}

// ─── --rollback / --dev shared repoint path (FEAT-438 SLICE-418 AC-3/AC-4) ──
//
// Both paths repoint current.json and restart WITHOUT ever calling
// installServiceFlow / adapter.install() — writeShim() only rewrites the
// cmd/launcher/pointer trio (shim.ts), it never touches the scheduler
// (schtasks / systemd unit / launchd plist). Task/unit/plist registration
// happens exactly once, at first install (`service install` / `init` / a
// plain `reinstall`); this preserves that invariant by construction rather
// than by a flag threaded through install-flow.ts, on every platform.

interface RepointVerifyOptions {
  jsonMode: boolean;
  log: (s: string) => void;
  port: number;
  dataDir: string;
  pointer: ShimPointer;
  expectedVersion: string;
  expectedLabel: string;
}

async function repointStopStartVerify(opts: RepointVerifyOptions): Promise<StepResult[]> {
  const { log, port, dataDir, pointer, expectedVersion, expectedLabel } = opts;
  const steps: StepResult[] = [];

  const pointerPath = shimPaths().pointerPath;
  let priorPointer: ShimPointer | null = null;
  if (existsSync(pointerPath)) {
    try {
      priorPointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as ShimPointer;
    } catch {
      priorPointer = null;
    }
  }
  let pointerRestoreDetail: string | null = null;
  const restoreOnce = (): string => {
    if (pointerRestoreDetail === null) {
      pointerRestoreDetail = restorePriorPointer(priorPointer, pointerPath);
    }
    return pointerRestoreDetail;
  };

  const stopResult = await stopRunningDaemon(dataDir, port);
  steps.push(stopResult);
  log(`  · stop daemon: ${stopResult.detail}`);
  if (!stopResult.ok) return steps;

  try {
    writeShim(pointer, shimPaths());
    steps.push({ step: 'repoint', ok: true, detail: `current.json → ${pointer.entryJs}` });
    log(`  · repointed: ${pointer.entryJs}`);
  } catch (err) {
    steps.push({ step: 'repoint', ok: false, detail: (err as Error).message });
    log(`  ✗ repoint failed: ${(err as Error).message}`);
    return steps;
  }

  try {
    await getServiceAdapter().start();
    steps.push({ step: 'start-service', ok: true });
    log('  · service started');
  } catch (err) {
    const restoreDetail = restoreOnce();
    const detail = `${(err as Error).message} — repoint aborted (${restoreDetail})`;
    steps.push({ step: 'start-service', ok: false, detail });
    log(`  ✗ start failed: ${detail}`);
    return steps;
  }

  const healthy = await waitForHealth(port, 30_000);
  if (!healthy) {
    const restoreDetail = restoreOnce();
    steps.push({
      step: 'verify-health',
      ok: false,
      detail: `/health not responding on port ${port} within 30s — repoint aborted (${restoreDetail})`,
    });
    return steps;
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { version?: string };
    if (body.version === expectedVersion) {
      steps.push({
        step: 'verify-version',
        ok: true,
        detail: `daemon serving v${body.version} (${expectedLabel})`,
      });
      log(`  ✓ daemon healthy, serving v${body.version} (${expectedLabel})`);
    } else {
      const restoreDetail = restoreOnce();
      steps.push({
        step: 'verify-version',
        ok: false,
        detail:
          `daemon reports v${body.version} but ${expectedLabel} expects v${expectedVersion} — ` +
          `repoint aborted (${restoreDetail}).`,
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

  return steps;
}

/**
 * Rollback target selection (FEAT-438 SLICE-418 AC-3): the immediately-
 * previous release is the newest release (per `listReleases`' newest-first
 * order) whose id differs from `currentId`. Returns null when there is no
 * such candidate (no releases on disk, or the only one present IS the
 * current one) — the caller must fail loudly rather than silently repointing
 * at nothing. Pure/no I/O — exported standalone so it's unit-testable
 * without a live daemon/schtasks.
 */
export function selectRollbackTarget(releases: ReleaseListEntry[], currentId: string | null): ReleaseListEntry | null {
  return releases.find(r => r.id !== currentId) ?? null;
}

/**
 * `reinstall --rollback` (AC-3): repoint current.json at the immediately-
 * previous release — the newest materialized release whose id differs from
 * the one current.json is presently pointed at. Never materializes; never
 * re-registers schtasks (see repointStopStartVerify header). If current.json
 * is missing, unreadable, or dev-pinned (its entryJs doesn't resolve to a
 * release id at all), "previous" falls back to the newest release overall —
 * there's nothing sane to exclude.
 */
async function reinstallRollback(jsonMode: boolean): Promise<void> {
  const log = (s: string) => { if (!jsonMode) console.log(s); };
  log(`\nAstraMemory reinstall --rollback — v${PKG_VERSION}\n`);

  const { port, dataDir } = resolveRuntimeConfig();
  const releasesRoot = defaultReleasesRoot();
  const releases = listReleases(releasesRoot);

  const pointerPath = shimPaths().pointerPath;
  let currentPointer: ShimPointer | null = null;
  if (existsSync(pointerPath)) {
    try {
      currentPointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as ShimPointer;
    } catch {
      currentPointer = null;
    }
  }
  const currentId = currentPointer ? releaseIdFromEntryJs(currentPointer.entryJs, releasesRoot) : null;

  const candidate = selectRollbackTarget(releases, currentId);
  if (!candidate) {
    const steps: StepResult[] = [{
      step: 'select-rollback-target',
      ok: false,
      detail:
        `no previous release to roll back to (found ${releases.length} release(s) on disk` +
        `${currentId ? `, current = ${currentId}` : ', current release unknown/dev-pinned'}) — current.json left untouched`,
    }];
    log(`  ✗ ${steps[0]!.detail}`);
    finish(steps, jsonMode);
    return;
  }

  const steps: StepResult[] = [{
    step: 'select-rollback-target',
    ok: true,
    detail: `${candidate.id} (current: ${currentId ?? 'unknown/dev-pinned'})`,
  }];
  log(`  · rollback target: ${candidate.id}`);

  let manifest: ReleaseManifest;
  try {
    manifest = JSON.parse(readFileSync(join(candidate.dir, 'release.json'), 'utf8')) as ReleaseManifest;
  } catch (err) {
    steps.push({ step: 'read-target-manifest', ok: false, detail: (err as Error).message });
    finish(steps, jsonMode);
    return;
  }

  const entryJs = join(candidate.dir, 'dist', 'cli', 'index.js');
  const logDir = join(dataDir, 'logs');
  const pointer: ShimPointer = { nodeBin: process.execPath, entryJs, port, logDir };

  steps.push(...await repointStopStartVerify({
    jsonMode, log, port, dataDir, pointer,
    expectedVersion: manifest.pkgversion,
    expectedLabel: `release ${candidate.id}`,
  }));

  finish(steps, jsonMode, [], `✓ rollback complete — daemon healthy on release ${candidate.id}.`);
}

/**
 * `reinstall --dev` (AC-4): escape hatch back to today's pre-FEAT-438
 * behavior — repoint current.json at the checkout's OWN `dist/cli/index.js`
 * (resolveBuild(), same resolution install-flow.ts's default path uses)
 * instead of an immutable release dir. Never materializes; never re-
 * registers schtasks. Marks the pointer `devPinned: true` so the doctor
 * check (AC-4) and `reinstall --rollback`'s target selection both know this
 * is NOT a release.
 *
 * This deliberately re-introduces the exact footgun FEAT-438 exists to close
 * (a `git pull` / partial `bun run build` can silently restrand the running
 * daemon) — hence the loud warning. It exists for fast local dev iteration
 * only; running plain `reinstall` afterward returns to a pinned release.
 */
async function reinstallDev(jsonMode: boolean): Promise<void> {
  const log = (s: string) => { if (!jsonMode) console.log(s); };
  log(`\nAstraMemory reinstall --dev — v${PKG_VERSION}\n`);
  log('  ⚠ DEV-PINNED: current.json points at the mutable checkout dist/ — NOT an immutable release.');
  log('  ⚠ Dev churn CAN restrand the daemon (the 2026-07-07 outage class).');
  log("  ⚠ Run 'reinstall' (no --dev) to return to a pinned release.");
  log('');

  const { port, dataDir } = resolveRuntimeConfig();
  const build = resolveBuild();

  const steps: StepResult[] = [];
  if (!existsSync(build.entryJs)) {
    steps.push({
      step: 'resolve-checkout-build',
      ok: false,
      detail: `CLI entry not found at ${build.entryJs} — the build is missing or partial. Run: bun install && bun run build`,
    });
    finish(steps, jsonMode);
    return;
  }
  steps.push({ step: 'resolve-checkout-build', ok: true, detail: build.entryJs });

  const logDir = join(dataDir, 'logs');
  const pointer: ShimPointer = { nodeBin: build.nodeBin, entryJs: build.entryJs, port, logDir, devPinned: true };

  steps.push(...await repointStopStartVerify({
    jsonMode, log, port, dataDir, pointer,
    expectedVersion: PKG_VERSION,
    expectedLabel: 'dev checkout',
  }));

  finish(
    steps,
    jsonMode,
    [],
    '✓ dev-pinned reinstall complete — daemon healthy, serving the mutable checkout dist/. Run plain "reinstall" to re-pin.',
  );
}
