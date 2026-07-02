#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from './serve.js';
import { cliSearch, cliRecall, cliRemember } from './search.js';
import { serviceCommand } from './service.js';
import { doctorCommand } from './doctor.js';
import { budgetCommand } from './budget.js';
import { init } from './init.js';
import { tokenCommand } from './token.js';
import { backupCommand } from './backup.js';
import { queueCommand } from './queue.js';
import { rebuildCommand } from './rebuild.js';
import { providersCommand } from './providers.js';
import { captureCommand } from './capture.js';
import { pairCommand } from './pair.js';

const PKG_VERSION: string = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'serve': {
      const port = parseArg(rest, '--port');
      await serve({ port: port ? Number(port) : undefined });
      break;
    }

    case 'search': {
      // astramem-local search "query" [--type TYPE] [--repo REPO] [--since 7d] [--limit N]
      const query = rest.find(a => !a.startsWith('-')) ?? '';
      await cliSearch(query, {
        type: parseArg(rest, '--type'),
        repo: parseArg(rest, '--repo'),
        since: parseArg(rest, '--since'),
        limit: parseArg(rest, '--limit')
      });
      break;
    }

    case 'recall': {
      // astramem-local recall "question" [--k N] [--type TYPE] [--repo REPO]
      const question = rest.find(a => !a.startsWith('-')) ?? '';
      await cliRecall(question, {
        k: parseArg(rest, '--k'),
        type: parseArg(rest, '--type'),
        repo: parseArg(rest, '--repo')
      });
      break;
    }

    case 'remember': {
      // astramem-local remember "text" [--type TYPE] [--repo REPO]
      const text = rest.find(a => !a.startsWith('-')) ?? '';
      if (!text) {
        console.error('remember: text argument is required');
        process.exit(1);
      }
      await cliRemember(text, {
        type: parseArg(rest, '--type'),
        repo: parseArg(rest, '--repo')
      });
      break;
    }

    case 'service': {
      // astramem-local service install|uninstall|start|stop|status [--port N]
      await serviceCommand(rest);
      break;
    }

    case 'doctor': {
      // astramem-local doctor [--json] [--port N]
      await doctorCommand(rest);
      break;
    }

    case 'budget': {
      // astramem-local budget [--reset]
      await budgetCommand(rest);
      break;
    }

    case 'init':
      // astramem-local init [--no-hook]
      await init(rest);
      break;

    case 'token':
      await tokenCommand(rest);
      break;

    case 'backup': {
      // astramem-local backup [--out PATH] [--keep N] [--json]
      await backupCommand(rest);
      break;
    }

    case 'queue': {
      // astramem-local queue [--json] [--limit N]
      await queueCommand(rest);
      break;
    }

    case 'rebuild': {
      // astramem-local rebuild [--repo REPO] [--project PROJECT] [--limit N] [--dry-run] [--json]
      await rebuildCommand(rest);
      break;
    }

    case 'providers': {
      // astramem-local providers [--json]
      await providersCommand(rest);
      break;
    }

    case 'capture': {
      // astramem-local capture codex [--sessions-dir D] [--dry-run] [--json]
      await captureCommand(rest);
      break;
    }

    case 'pair': {
      // astramem-local pair <claim-code> --url <cloud-url>
      await pairCommand(rest);
      break;
    }

    case '--version':
    case '-v':
      console.log(PKG_VERSION);
      break;

    case undefined:
    case '--help':
    case '-h':
      console.log(`astramem-local <command>

Commands:
  serve [--port N]                       Start daemon (foreground)
  service install|uninstall|start|stop|status [--port N]
                                         Manage OS service (systemd/launchd/schtasks)
  doctor [--json] [--port N]             Run health checks
  search "query" [--type TYPE] [--repo REPO] [--since 7d|24h] [--limit N]
  recall "question" [--k N] [--type TYPE] [--repo REPO]
  remember "text" [--type TYPE] [--repo REPO]
  budget [--reset]                       Show today + month LLM spend vs cap
  backup [--out PATH] [--keep N] [--json] Snapshot DB; prune old backups
  init [--no-hook]                       Interactive setup wizard (--no-hook skips the
                                         SessionStart memory-pack hook offer)
  token rotate                           Issue new local Bearer token
  queue [--json] [--limit N]             Show job-queue state counts + recent failures
  rebuild [--repo R] [--project P] [--limit N] [--dry-run] [--json]
                                         Queue reembed jobs for existing memories
  providers [--json]                     Show configured providers + live health probes
  capture codex [--sessions-dir D] [--dry-run] [--json]
                                         Ingest new Codex CLI sessions (ADR-008)
  pair <claim-code> --url <cloud-url>    Pair with AstraMemory cloud (claim code
                                         from dashboard); enables sync shipper

Environment:
  ASTRA_MEMORY_URL       Daemon base URL (default: http://127.0.0.1:7777)
  ASTRA_MEMORY_TOKEN     Bearer token (default: devtok)
  ASTRA_MEMORY_DATADIR   Data directory (overrides config)`);
      break;

    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
