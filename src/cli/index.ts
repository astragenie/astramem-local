#!/usr/bin/env node
import { serve } from './serve.js';
import { cliSearch, cliRecall, cliRemember } from './search.js';
import { serviceCommand } from './service.js';
import { doctorCommand } from './doctor.js';
import { budgetCommand } from './budget.js';
import { init } from './init.js';
import { tokenCommand } from './token.js';
import { backupCommand } from './backup.js';

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
      // astra-memory search "query" [--type TYPE] [--repo REPO] [--since 7d] [--limit N]
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
      // astra-memory recall "question" [--k N] [--type TYPE] [--repo REPO]
      const question = rest.find(a => !a.startsWith('-')) ?? '';
      await cliRecall(question, {
        k: parseArg(rest, '--k'),
        type: parseArg(rest, '--type'),
        repo: parseArg(rest, '--repo')
      });
      break;
    }

    case 'remember': {
      // astra-memory remember "text" [--type TYPE] [--repo REPO]
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
      // astra-memory service install|uninstall|start|stop|status [--port N]
      await serviceCommand(rest);
      break;
    }

    case 'doctor': {
      // astra-memory doctor [--json] [--port N]
      await doctorCommand(rest);
      break;
    }

    case 'budget': {
      // astra-memory budget [--reset]
      await budgetCommand(rest);
      break;
    }

    case 'init':
      await init();
      break;

    case 'token':
      await tokenCommand(rest);
      break;

    case 'backup': {
      // astra-memory backup [--out PATH] [--keep N] [--json]
      await backupCommand(rest);
      break;
    }

    case undefined:
    case '--help':
    case '-h':
      console.log(`astra-memory <command>

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
  init                                   Interactive setup wizard
  token rotate                           Issue new local Bearer token

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
