/**
 * keystore-child.ts — out-of-thread OS credential-store access
 * (keystore-read-timeout, 2026-08-02 incident).
 *
 * Standalone entry point, NEVER imported by anything else in this repo —
 * only ever invoked as a short-lived child process by keystore-bounded.ts's
 * `boundedGetPassword`/`boundedSetPassword`. Exists because
 * `Entry.getPassword()`/`.setPassword()` (`@napi-rs/keyring`) are
 * SYNCHRONOUS N-API calls into the OS credential store with no timeout
 * anywhere in the chain — see keystore-bounded.ts's
 * `CREDENTIAL_STORE_TIMEOUT_MS` doc comment for the full incident writeup
 * (four consecutive daemon boots hung FOREVER, pre-bind, zero log output)
 * and why the bound has to be a killable child process rather than a
 * worker_thread (a worker blocked inside the same native call cannot be
 * preempted by `Worker.terminate()` either — only an OS-level process kill
 * can reclaim it).
 *
 * Invocation contract (keystore-bounded.ts is the only caller — keep the
 * two files in lock-step):
 *
 *   node keystore-child.js get <service> <account>
 *     -> stdout: JSON.stringify({ found: boolean, value: string | null })
 *     -> exit 0 always (a NoEntry-shaped throw from getPassword() is
 *        reported as `{ found: false, value: null }`, mirroring
 *        keystore.ts's own long-standing "throw or null both mean 'no key
 *        yet'" tolerance — see getOrCreateCredentialStoreKey's doc comment)
 *     -> exit 1 + stderr message only for a genuine setup failure (e.g. the
 *        Entry CONSTRUCTOR itself throwing)
 *
 *   node keystore-child.js set <service> <account>
 *     -> secret is read from STDIN, never argv (argv is visible to other
 *        local processes via `tasklist`/`ps` on some platforms/configs;
 *        stdin fed through execFileSync's own `input` option is not — see
 *        boundedSetPassword's doc comment for the full security note)
 *     -> exit 0 on success, exit 1 + stderr message on failure
 *
 * Deliberately minimal: no logging, no imports beyond `@napi-rs/keyring`
 * and `node:fs` (for the stdin read) — every extra dependency here is one
 * more thing that could itself hang or fail inside the very process meant
 * to bound a hang.
 */
import { Entry } from '@napi-rs/keyring';
import { readFileSync } from 'node:fs';

function fail(message: string): never {
  process.stderr.write(`keystore-child: ${message}\n`);
  process.exit(1);
}

const [, , mode, service, account] = process.argv;

if (mode !== 'get' && mode !== 'set') {
  fail(`usage: node keystore-child.js <get|set> <service> <account> (got mode=${String(mode)})`);
}
if (!service || !account) {
  fail('missing service/account argument');
}

try {
  const entry = new Entry(service, account);

  if (mode === 'get') {
    // getPassword() returns null when absent on some platforms but throws a
    // NoEntry-shaped error on others (per @napi-rs/keyring docs, and already
    // documented/tolerated in keystore.ts) — collapse both into
    // `found: false` here so the parent's JSON.parse never has to
    // distinguish them; that distinction was never meaningful to any caller.
    let value: string | null;
    try {
      value = entry.getPassword();
    } catch {
      value = null;
    }
    process.stdout.write(JSON.stringify({ found: value !== null && value !== undefined, value: value ?? null }));
    process.exit(0);
  }

  // mode === 'set': the secret arrives over stdin (fd 0), fed by the
  // parent's execFileSync `input` option — never as a command-line
  // argument. Read synchronously; the whole point of moving this into a
  // child process is that THIS thread blocking briefly on its own stdin is
  // fine — the parent bounds the CHILD's total wall-clock time, not this
  // read specifically.
  const secret = readFileSync(0, 'utf8');
  entry.setPassword(secret);
  process.exit(0);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
