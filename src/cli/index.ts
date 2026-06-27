#!/usr/bin/env node
import { serve } from './serve.js';
import { cliSearch, cliRecall, cliRemember } from './search.js';

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Returns true if the flag is present (boolean flag with no value) */
function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
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

    case 'init':
      console.log('init wizard lands in M5');
      break;

    case undefined:
    case '--help':
    case '-h':
      console.log(`astra-memory <command>

Commands:
  serve [--port N]                       Start daemon (foreground)
  search "query" [--type TYPE] [--repo REPO] [--since 7d|24h] [--limit N]
  recall "question" [--k N] [--type TYPE] [--repo REPO]
  remember "text" [--type TYPE] [--repo REPO]
  init                                   Interactive wizard (M5)

Environment:
  ASTRA_MEMORY_URL    Daemon base URL (default: http://127.0.0.1:7777)
  ASTRA_MEMORY_TOKEN  Bearer token (default: devtok)`);
      break;

    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
