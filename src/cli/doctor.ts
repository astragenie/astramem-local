import { join } from 'node:path';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { getChecks, openProductionDbReadonly } from '../doctor/checks.js';
import { getHardeningChecks } from '../doctor/hardening-checks.js';
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

  // Shared resolver — doctor must probe the SAME dataDir the daemon serves
  // from (config.yaml included), not the compile-time default. Previously a
  // non-default config.yaml dataDir made doctor probe the wrong directory,
  // producing false "file is not a database" failures.
  const { cfg, port, dataDir } = resolveRuntimeConfig({
    port: portArg ? Number(portArg) : undefined,
  });

  const checks = [
    ...getChecks({
      port,
      dataDir,
      redactionEnabled: cfg.security.redaction.enabled,
      encryptionEnabled: cfg.security.encryption.enabled,
      durabilityGateMode: cfg.distill.durabilityGate,
    }),
    // W1.3: parity with `reinstall`'s assertions — stranded legacy DB,
    // plaintext pre-encryption backup, served-vs-build version, zombie
    // instance lock, poison-job accumulation.
    ...getHardeningChecks({
      dataDir,
      port,
      openDbReadonly: () =>
        openProductionDbReadonly(join(dataDir, 'memory.sqlite'), cfg.security.encryption.enabled),
    }),
  ];
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
