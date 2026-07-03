import { getServiceAdapter } from '../service/index.js';
import { installServiceFlow } from '../service/install-flow.js';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
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
      try {
        await adapter.stop();
        console.log('Service stopped.');
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      break;
    }

    case 'status': {
      const status = await adapter.status();
      if (status.installed) {
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

    case undefined:
    case '--help':
    case '-h':
      console.log(`astramem-local service <subcommand>

Subcommands:
  install [--port N] [--with-backup-timer] [--keep N]
                       Install OS service (systemd/launchd/schtasks)
                       --with-backup-timer  also install nightly 03:00 backup timer
                       --keep N             retain N snapshots (default: 7)
  uninstall            Remove OS service (also removes backup timer if present)
  start                Start service via OS init
  stop                 Stop service via OS init
  status               Show service status`);
      break;

    default:
      console.error(`unknown service subcommand: ${subCmd}`);
      process.exit(1);
  }
}
