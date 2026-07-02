import { defaultConfig } from '../config/config.js';
import { getChecks } from '../doctor/checks.js';
import { runChecks, formatTable, formatJson } from '../doctor/runner.js';

function parseFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function doctorCommand(args: string[]): Promise<void> {
  const jsonMode = parseFlag(args, '--json');
  const portArg = parseArg(args, '--port');

  const cfg = defaultConfig();
  const port = portArg ? Number(portArg) : cfg.port;
  const dataDir = process.env.ASTRA_MEMORY_DATADIR ?? cfg.dataDir;

  const checks = getChecks({
    port,
    dataDir,
    redactionEnabled: cfg.security.redaction.enabled,
    encryptionEnabled: cfg.security.encryption.enabled,
  });
  const results = await runChecks(checks);

  if (jsonMode) {
    console.log(formatJson(results));
  } else {
    console.log('\nAstraMemory Doctor\n');
    console.log(formatTable(results));
    const failCount = results.filter(r => !r.ok).length;
    const okCount = results.filter(r => r.ok).length;
    console.log(`\n  ${okCount} passed, ${failCount} failed\n`);
  }

  const hasFailures = results.some(r => !r.ok);
  if (hasFailures) process.exit(1);
}
