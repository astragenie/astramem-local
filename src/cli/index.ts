#!/usr/bin/env node
import { serve } from './serve.js';

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
    case 'init':
      console.log('init wizard lands in M5');
      break;
    case undefined:
    case '--help':
    case '-h':
      console.log(`astra-memory <command>

Commands:
  serve [--port N]     Start daemon (foreground)
  init                 Interactive wizard (M5)

(More commands added in later waves.)`);
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
