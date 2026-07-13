import { getServiceAdapter } from '../service/index.js';
import { installServiceFlow } from '../service/install-flow.js';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { stopLockHolder } from '../service/instance-lock.js';
import { hasWatchdogTimer, runWatchdogProbe } from '../service/watchdog-probe.js';
import { reinstallCommand } from './reinstall.js';

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function serviceCommand(args: string[]): Promise<void> {
  const [subCmd, ...rest] = args;
  const adapter = getServiceAdapter();

  switch (subCmd) {
    case 'install': {
      const portArg = parseArg(rest, '--port');
      const keepArg = parseArg(rest, '--keep');
      const withBackupTimer = rest.includes('--with-backup-timer');
      const { port: cfgPort } = resolveRuntimeConfig({
        port: portArg ? Number(portArg) : undefined,
      });
      const port = cfgPort;
      const keep = keepArg ? Number(keepArg) : 7;
      console.log(`Installing AstraMemory service for ${adapter.platform}...`);
      // Single shared install path (shim + XML task on Windows) — same code
      // that `init` and `reinstall` use.
      const { result, build } = await installServiceFlow(port);
      if (result.kind === 'task') {
        console.log("Service installed. Run 'astramem-local service start' to start it.");
      } else {
        // Startup-shortcut fallback — be honest about limitations.
        console.log(`Startup shortcut installed at ${result.path}.`);
        console.log('It will run the daemon at next logon.');
        console.log(`To start now: astramem-local serve --port ${port}`);
        console.log(
          "NOTE: 'astramem-local service start' will NOT work — no scheduled task exists.\n" +
          "      Re-run 'astramem-local service install' from an elevated shell to install a proper task.",
        );
      }
      if (withBackupTimer) {
        console.log('Installing nightly backup timer (03:00)...');
        // The backup timer runs `backup --keep N` — it needs the direct
        // node+entry command, NOT the daemon shim.
        await adapter.installBackupTimer(build.rawExecPath, keep);
        console.log(`Backup timer installed (keep=${keep} snapshots).`);
      }
      break;
    }

    case 'repair': {
      // Alias for the full reinstall ceremony.
      await reinstallCommand(rest);
      break;
    }

    case 'uninstall': {
      console.log('Uninstalling AstraMemory service...');
      await adapter.uninstall();
      try { await adapter.uninstallBackupTimer(); } catch { /* timer may not be installed */ }
      if (hasWatchdogTimer(adapter)) {
        try { await adapter.uninstallWatchdogTimer(); } catch { /* timer may not be installed */ }
      }
      console.log('Service uninstalled.');
      break;
    }

    case 'start': {
      console.log('Starting AstraMemory service...');
      try {
        await adapter.start();
        console.log('Service started.');
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      break;
    }

    case 'stop': {
      console.log('Stopping AstraMemory service...');
      // Best-effort: end the scheduler's own task/unit first so its
      // keepalive repetition trigger doesn't relaunch what we're about to
      // kill below. Not fatal on its own — e.g. schtasks errors when the
      // task isn't currently "running" — the PID-based stop is the real,
      // idempotent success signal.
      try {
        await adapter.stop();
      } catch { /* see comment above */ }

      // adapter.stop() only ends the scheduler's own launcher process — the
      // shim spawns the actual daemon as a detached child (launch.cjs reads
      // current.json and spawnSync()s it), which can keep running — and keep
      // answering /health — after the task is reported "ended". Terminate
      // whatever is actually holding daemon.lock, directly.
      const { port, dataDir } = resolveRuntimeConfig();
      const stopResult = await stopLockHolder(dataDir, port);
      if (!stopResult.ok) {
        console.error(`Service stop failed: ${stopResult.detail}`);
        process.exit(1);
      }
      console.log(`Service stopped. (${stopResult.detail})`);
      break;
    }

    case 'status': {
      const status = await adapter.status();
      if (status.inconclusive) {
        // The OS query itself failed (timeout, missing scheduler binary,
        // DBus/launchd unavailable) — `installed`/`running` below are NOT
        // confirmed. Printing "not installed" here would be a confident,
        // wrong, actionable instruction produced by a timeout (ADR-015
        // rule 4) — say plainly that the query failed instead.
        console.log('Service: could not determine (status query failed — this is NOT confirmation the service is uninstalled or stopped)');
        if (status.detail) console.log(`  Detail: ${status.detail}`);
        console.log('  Try again, or check manually via the OS scheduler directly.');
      } else if (status.installed) {
        const state = status.running ? 'running' : 'stopped';
        console.log(`Service: installed, ${state}${status.pid ? ` (pid ${status.pid})` : ''}`);
        if (status.detail) console.log(`  Detail: ${status.detail}`);
      } else {
        console.log('Service: not installed');
        if (status.detail) console.log(`  ${status.detail}`);
        console.log("  Run 'astramem-local service install' to install.");
      }
      break;
    }

    case 'watchdog-probe': {
      // astramem-local service watchdog-probe — invoked unattended by the
      // systemd timer / launchd StartInterval agent / Windows
      // AstraMemoryDWatchdog scheduled task installed alongside the main
      // service (FEAT-443 SLICE-2; win32 added by issue #206,
      // install-flow.ts). Never exits non-zero on an unhealthy probe: this
      // runs on a schedule with no one watching in real time, and the
      // recovery action (or its failure) is reported on stdout for the
      // unit's/task's own log, not via exit code.
      const portArg = parseArg(rest, '--port');
      const { port, dataDir } = resolveRuntimeConfig({ port: portArg ? Number(portArg) : undefined });
      const result = await runWatchdogProbe({ port, dataDir, adapter });
      console.log(`[watchdog-probe] ${result.healthy ? 'healthy' : 'UNHEALTHY'} — ${result.action}: ${result.detail}`);
      break;
    }

    case undefined:
    case '--help':
    case '-h':
      console.log(`astramem-local service <subcommand>

Subcommands:
  install [--port N] [--with-backup-timer] [--keep N]
                       Install OS service (systemd/launchd/schtasks)
                       --with-backup-timer  also install nightly 03:00 backup timer
                       --keep N             retain N snapshots (default: 7)
  uninstall            Remove OS service (also removes backup timer + hang-watchdog
                       probe timer, if present)
  start                Start service via OS init
  stop                 Stop service via OS init
  status               Show service status
  watchdog-probe [--port N]
                       Hang-detection probe (FEAT-443 SLICE-2 + issue #206;
                       systemd/launchd/schtasks) — hits /health and, after N
                       consecutive failures, force-restarts the daemon if
                       still unresponsive. Installed as a recurring
                       timer/agent/task automatically by 'install'; not meant
                       to be run interactively, but safe to invoke by hand.`);
      break;

    default:
      console.error(`unknown service subcommand: ${subCmd}`);
      process.exit(1);
  }
}
