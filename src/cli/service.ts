import { getServiceAdapter } from '../service/index.js';
import { defaultConfig } from '../config/config.js';

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Resolve the absolute path to the CLI entry point for the daemon.
 * Uses the resolved location of this file to find dist/cli/index.js.
 */
function resolveCliExecPath(): string {
  const nodeBin = process.execPath;
  // __filename is not available in ESM — use import.meta.url
  const thisFile = new URL(import.meta.url).pathname;
  // Strip leading slash on Windows: /C:/path → C:/path
  const normalized = thisFile.replace(/^\/([A-Za-z]:)/, '$1');
  // dist/cli/service.js → dist/cli/index.js
  const indexJs = normalized.replace(/service\.(js|ts)$/, 'index.js');
  return `"${nodeBin}" "${indexJs}"`;
}

export async function serviceCommand(args: string[]): Promise<void> {
  const [subCmd, ...rest] = args;
  const adapter = getServiceAdapter();

  switch (subCmd) {
    case 'install': {
      const portArg = parseArg(rest, '--port');
      const keepArg = parseArg(rest, '--keep');
      const withBackupTimer = rest.includes('--with-backup-timer');
      const cfg = defaultConfig();
      const port = portArg ? Number(portArg) : cfg.port;
      const keep = keepArg ? Number(keepArg) : 7;
      const execPath = resolveCliExecPath();
      console.log(`Installing AstraMemory service for ${adapter.platform}...`);
      await adapter.install(execPath, port);
      console.log('Service installed. Run `astra-memory service start` to start it.');
      if (withBackupTimer) {
        console.log('Installing nightly backup timer (03:00)...');
        await adapter.installBackupTimer(execPath, keep);
        console.log(`Backup timer installed (keep=${keep} snapshots).`);
      }
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
      await adapter.start();
      console.log('Service started.');
      break;
    }

    case 'stop': {
      console.log('Stopping AstraMemory service...');
      await adapter.stop();
      console.log('Service stopped.');
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
        console.log('  Run `astra-memory service install` to install.');
      }
      break;
    }

    case undefined:
    case '--help':
    case '-h':
      console.log(`astra-memory service <subcommand>

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
