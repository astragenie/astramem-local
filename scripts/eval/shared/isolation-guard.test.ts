/**
 * The isolation guard must FIRE. A guard nobody has watched trip is a comment.
 *
 * Incident (2026-07-13): an agent called `spawnEvalDaemon` without also calling
 * `makeIsolatedEvalEnv`. The child inherited the real APPDATA, read the operator's real
 * `sync.json` (`enabled: true`, `url: https://api.astramemory.com`, a real tenantId) and
 * may have started the sync shipper against their live cloud tenant. Impact was low —
 * but by luck, not by design, and unprovable afterwards because the process died with
 * its logs.
 *
 * Root cause was not the agent. It was that `spawnEvalDaemon` and `makeIsolatedEvalEnv`
 * were two separate opt-ins with nothing pairing them, so forgetting one silently
 * pointed a daemon at production credentials.
 */
import { describe, it, expect } from 'vitest';
import { spawnEvalDaemon, makeIsolatedEvalEnv } from './spawn-daemon.js';

describe('spawnEvalDaemon isolation guard (2026-07-13 incident)', () => {
  it('REFUSES to spawn the real daemon when the child would inherit the real config dir', async () => {
    // No env overrides -> child inherits real APPDATA/HOME -> would read real sync.json.
    await expect(
      spawnEvalDaemon({ dataDir: 'C:/tmp/whatever', token: 'x' }),
    ).rejects.toThrow(/REFUSED to start/);
  });

  it('names the real risk in the error, not just "isolation failed"', async () => {
    // The message has to tell a tired human at 2am WHY this matters, or they will
    // reach for allowRealConfigDir to make the red text go away.
    await expect(
      spawnEvalDaemon({ dataDir: 'C:/tmp/whatever', token: 'x' }),
    ).rejects.toThrow(/sync\.json|credentials|live tenant/i);
  });

  it('allows a properly isolated spawn to proceed past the guard', async () => {
    const iso = makeIsolatedEvalEnv('isolation-guard-test');
    // It will still fail LATER (the command exits without printing a bound port), but it
    // must NOT fail with the guard's refusal — that is the assertion.
    await expect(
      spawnEvalDaemon({
        dataDir: iso.configDir,
        token: 'x',
        env: { ...iso.env },
        command: ['dist/cli/index.js', '--version'], // real binary, but isolated env
      }),
    ).rejects.not.toThrow(/REFUSED to start/);
  });

  it('does NOT block a stub-fixture daemon (it never reads config, so there is no risk)', async () => {
    // False positives train people to reach for the escape hatch. The fake eval daemon
    // implements just enough of the wire surface to be health-checked; it touches no
    // config.yaml, no sync.json, no credential store.
    await expect(
      spawnEvalDaemon({
        dataDir: 'C:/tmp/whatever',
        token: 'x',
        command: ['scripts/eval/shared/__fixtures__/fake-eval-daemon.mjs', '--port', '0'],
      }),
    ).rejects.not.toThrow(/REFUSED to start/);
  });

  it('honors the explicit escape hatch — danger must be opt-in, never accidental', async () => {
    // NOTE: `command: ['dist/cli/index.js', '--version']` on purpose. The FIRST draft of
    // this test passed no command, which means it spawned a REAL SERVING DAEMON against
    // the operator's REAL config — i.e. it reproduced the very incident this guard exists
    // to prevent, inside the test suite that proves the guard works. `--version` exercises
    // the same real binary (so the guard still applies) and exits immediately: no server,
    // no sync shipper, no credential read.
    await expect(
      spawnEvalDaemon({
        dataDir: 'C:/tmp/whatever',
        token: 'x',
        allowRealConfigDir: true,
        command: ['dist/cli/index.js', '--version'],
      }),
    ).rejects.not.toThrow(/REFUSED to start/);
  });
});
