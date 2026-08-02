/**
 * keystore-bounded.test.ts — timeout boundary around OS credential-store
 * access (keystore-read-timeout, 2026-08-02 incident).
 *
 * Exercises boundedGetPassword/boundedSetPassword/BoundedEntry against
 * on-the-fly FIXTURE scripts injected via __setChildScriptPathForTests —
 * never a real OS keychain (unreproducible hang, and mutating the
 * developer's real credential store as a side effect of `npm test` is
 * unacceptable — same reasoning as keystore.ts's own EntryCtor seam). Each
 * fixture is a tiny dependency-free .mjs written to a temp dir per test,
 * invoked exactly the way keystore-child.js is: `node <fixture> <mode>
 * <service> <account>`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  boundedGetPassword,
  boundedSetPassword,
  BoundedEntry,
  CREDENTIAL_STORE_TIMEOUT_MS,
  __setChildScriptPathForTests,
} from '../../src/storage/keystore-bounded.js';

describe('keystore-bounded', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-keystore-bounded-'));
  });

  afterEach(() => {
    __setChildScriptPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  function fixture(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, body, 'utf8');
    return path;
  }

  // ─────────────────────────────────────────────────────────────────────
  // boundedGetPassword
  // ─────────────────────────────────────────────────────────────────────

  describe('boundedGetPassword', () => {
    it('returns status "found" with the value when the child reports one', () => {
      const script = fixture(
        'found.mjs',
        "process.stdout.write(JSON.stringify({ found: true, value: 'the-secret-value' }));",
      );
      __setChildScriptPathForTests(script);
      const result = boundedGetPassword('svc', 'acct');
      expect(result).toEqual({ status: 'found', value: 'the-secret-value' });
    });

    it('returns status "not-found" (value null) when the child reports none — same tolerance as a real NoEntry throw', () => {
      const script = fixture('not-found.mjs', "process.stdout.write(JSON.stringify({ found: false, value: null }));");
      __setChildScriptPathForTests(script);
      const result = boundedGetPassword('svc', 'acct');
      expect(result).toEqual({ status: 'not-found', value: null });
    });

    it('returns status "error" (not "not-found") when the child exits non-zero for a real reason — ADR-015 rule 4: a real error is not collapsed into a domain value', () => {
      const script = fixture(
        'errors.mjs',
        "process.stderr.write('simulated: constructor threw'); process.exit(1);",
      );
      __setChildScriptPathForTests(script);
      const result = boundedGetPassword('svc', 'acct');
      expect(result.status).toBe('error');
      expect(result.value).toBeNull();
      expect(result.errorMessage).toBeTruthy();
    });

    it('returns status "timeout" (not "not-found" or "error") when the child hangs past timeoutMs, and the wait is bounded to roughly timeoutMs — not "forever"', () => {
      // Keeps the child alive (event-loop I/O wait, not a CPU spin) well past
      // the test's own short timeout — simulates a wedged credential-store
      // RPC without actually needing one.
      const script = fixture('hangs.mjs', 'setTimeout(() => process.exit(0), 60_000);');
      __setChildScriptPathForTests(script);

      const startedAt = Date.now();
      const result = boundedGetPassword('svc', 'acct', 300);
      const elapsedMs = Date.now() - startedAt;

      expect(result.status).toBe('timeout');
      expect(result.value).toBeNull();
      expect(result.errorMessage).toMatch(/timed out/i);
      // The whole point: bounded, not "forever". Generous upper bound for
      // process-spawn/teardown overhead on a loaded CI box.
      expect(elapsedMs).toBeLessThan(5_000);
    });

    it('WARNs loudly on a timeout (ADR-015 rule 4: a distinguishable, visible state) even though the caller only sees a status field', () => {
      const script = fixture('hangs2.mjs', 'setTimeout(() => process.exit(0), 60_000);');
      __setChildScriptPathForTests(script);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        boundedGetPassword('svc', 'acct', 300);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]![0]).toMatch(/timed out after 300ms/i);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('never leaks the secret value into the command line — only service/account (non-secret labels) are passed as argv', () => {
      // Fixture echoes back its OWN argv so the test can assert on it —
      // proves boundedGetPassword's argv never carries anything but
      // service/account, regardless of what the credential store returns.
      const script = fixture(
        'echo-argv.mjs',
        "process.stdout.write(JSON.stringify({ found: true, value: JSON.stringify(process.argv.slice(2)) }));",
      );
      __setChildScriptPathForTests(script);
      const result = boundedGetPassword('scoped-service-hash', 'db-key');
      const argv = JSON.parse(result.value!) as string[];
      expect(argv).toEqual(['get', 'scoped-service-hash', 'db-key']);
    });

    it('CREDENTIAL_STORE_TIMEOUT_MS is the default when no explicit timeoutMs is passed', () => {
      // Not a behavioral assertion (5s is too slow to actually wait out in a
      // unit test) — just pins the exported constant's value so a future
      // edit notices it changed.
      expect(CREDENTIAL_STORE_TIMEOUT_MS).toBe(5_000);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // boundedSetPassword
  // ─────────────────────────────────────────────────────────────────────

  describe('boundedSetPassword', () => {
    it('succeeds silently when the child exits 0', () => {
      const script = fixture('set-ok.mjs', 'process.exit(0);');
      __setChildScriptPathForTests(script);
      expect(() => boundedSetPassword('svc', 'acct', 'the-secret')).not.toThrow();
    });

    it('feeds the secret to the child over STDIN, never as a command-line argument', () => {
      const markerPath = join(dir, 'received-secret.txt');
      // .cjs extension (not .mjs): plain `require` is the simplest way to
      // read a synchronous fd here, independent of the repo's own
      // "type": "module" — fixture scripts are never part of the module
      // graph, so either module system works; this one just needs `require`.
      const script = fixture(
        'set-capture.cjs',
        [
          "const fs = require('node:fs');",
          "const secret = fs.readFileSync(0, 'utf8');",
          `fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ secret, argv: process.argv.slice(2) }));`,
        ].join('\n'),
      );
      __setChildScriptPathForTests(script);

      boundedSetPassword('scoped-service-hash', 'bearer', 'super-secret-token-value');

      const captured = JSON.parse(readFileSync(markerPath, 'utf8')) as { secret: string; argv: string[] };
      expect(captured.secret).toBe('super-secret-token-value');
      // argv carries only the non-secret service/account labels.
      expect(captured.argv).toEqual(['set', 'scoped-service-hash', 'bearer']);
      expect(captured.argv.join(' ')).not.toContain('super-secret-token-value');
    });

    it('throws (mirroring a real Entry.setPassword() failure) when the child exits non-zero', () => {
      const script = fixture('set-fails.mjs', "process.stderr.write('simulated write failure'); process.exit(1);");
      __setChildScriptPathForTests(script);
      expect(() => boundedSetPassword('svc', 'acct', 'secret')).toThrow();
    });

    it('throws within roughly timeoutMs (not "forever") when the child hangs, with a message identifying it as a timeout', () => {
      const script = fixture('set-hangs.mjs', 'setTimeout(() => process.exit(0), 60_000);');
      __setChildScriptPathForTests(script);

      const startedAt = Date.now();
      expect(() => boundedSetPassword('svc', 'acct', 'secret', 300)).toThrow(/timed out/i);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // BoundedEntry — the class keystore.ts wires in as EntryCtor's default
  // ─────────────────────────────────────────────────────────────────────

  describe('BoundedEntry', () => {
    it('getPassword() returns the value on a "found" result', () => {
      const script = fixture('be-found.mjs', "process.stdout.write(JSON.stringify({ found: true, value: 'v1' }));");
      __setChildScriptPathForTests(script);
      expect(new BoundedEntry('svc', 'acct').getPassword()).toBe('v1');
    });

    it('getPassword() returns null on a "not-found" result — same as a real Entry on some platforms', () => {
      const script = fixture('be-notfound.mjs', 'process.stdout.write(JSON.stringify({ found: false, value: null }));');
      __setChildScriptPathForTests(script);
      expect(new BoundedEntry('svc', 'acct').getPassword()).toBeNull();
    });

    it('getPassword() throws on a timeout — callers\' existing inline catch-swallow-to-null pattern (keystore.ts) still degrades to "no key yet", exactly like a real Entry throw does today', { timeout: CREDENTIAL_STORE_TIMEOUT_MS + 10_000 }, () => {
      const script = fixture('be-hangs.mjs', 'setTimeout(() => process.exit(0), 60_000);');
      __setChildScriptPathForTests(script);
      const entry = new BoundedEntry('svc', 'acct');
      // BoundedEntry itself always uses the module default timeout (5s,
      // uninjectable by design — see the file header) — proven bounded (not
      // "forever") by the elapsed-time assertion. This is the one test in
      // the suite that has to actually wait out the real default rather
      // than a short injected timeoutMs, hence the raised vitest timeout.
      const startedAt = Date.now();
      expect(() => entry.getPassword()).toThrow();
      expect(Date.now() - startedAt).toBeLessThan(CREDENTIAL_STORE_TIMEOUT_MS + 5_000);
    });

    it('setPassword() delegates to boundedSetPassword and throws on failure', () => {
      const script = fixture('be-set-fails.mjs', 'process.exit(1);');
      __setChildScriptPathForTests(script);
      expect(() => new BoundedEntry('svc', 'acct').setPassword('x')).toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // End-to-end wiring: keystore.ts's public getOrCreateKey(), with
  // EntryCtor left at its REAL default (never stubbed via
  // __setEntryCtorForTests) — proves BoundedEntry is genuinely on the live
  // path, not just unit-tested in isolation. This repo has a documented
  // recurring failure class of "built, wired, never invoked" (see
  // CLAUDE.md) — these tests are the invocation proof for this fix.
  // ─────────────────────────────────────────────────────────────────────

  describe('end-to-end: getOrCreateKey() through the real BoundedEntry default', () => {
    it('a fast credential-store response flows all the way through getOrCreateKey() without EntryCtor being stubbed', async () => {
      const { getOrCreateKey } = await import('../../src/storage/keystore.js');
      const script = fixture(
        'e2e-found.mjs',
        "process.stdout.write(JSON.stringify({ found: true, value: 'e2e-fixture-key-value' }));",
      );
      __setChildScriptPathForTests(script);
      const configDir = mkdtempSync(join(tmpdir(), 'astra-keystore-e2e-'));
      try {
        const result = getOrCreateKey(configDir);
        expect(result.source).toBe('credential-store');
        expect(result.key).toBe('e2e-fixture-key-value');
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it(
      'getOrCreateKey() falls back to the EXISTING key-file path (with a WARN) instead of hanging forever, when the credential store is genuinely unresponsive — the incident this fix closes, reproduced end-to-end',
      { timeout: CREDENTIAL_STORE_TIMEOUT_MS + 15_000 },
      async () => {
        const { getOrCreateKey, keyFilePath } = await import('../../src/storage/keystore.js');
        // Hangs on every call. getOrCreateCredentialStoreKey's SCOPED read
        // times out first and now (keystore-read-timeout follow-up: a
        // timeout must never be swallowed into "proceed to mint") re-throws
        // CredentialStoreTimeoutError immediately instead of falling through
        // to a legacy read + mint attempt — so this exercises ONE
        // CREDENTIAL_STORE_TIMEOUT_MS wait, not the full chain. Still slow
        // (~5s) but bounded, and now faster than the original 3x-chained
        // design — see the dedicated "existing key + timed-out read must
        // not be minted over" test below for why that short-circuit exists.
        const script = fixture('e2e-hangs.mjs', 'setTimeout(() => process.exit(0), 120_000);');
        __setChildScriptPathForTests(script);
        const configDir = mkdtempSync(join(tmpdir(), 'astra-keystore-e2e-hang-'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const startedAt = Date.now();
          const result = getOrCreateKey(configDir);
          const elapsedMs = Date.now() - startedAt;

          expect(result.source).toBe('key-file');
          expect(result.key).toMatch(/^[0-9a-f]{64}$/);
          expect(readFileSync(keyFilePath(configDir), 'utf8').trim()).toBe(result.key);
          // Bounded: comfortably under what "hangs forever" would look like.
          // One timeout (the scoped read's short-circuit), not three chained
          // — see the comment above.
          expect(elapsedMs).toBeLessThan(CREDENTIAL_STORE_TIMEOUT_MS + 10_000);
          // NOTE: assert on the spy BEFORE restoring it — mockRestore()
          // clears recorded calls as part of restoring the original
          // implementation, so checking afterward would always see zero.
          expect(warnSpy).toHaveBeenCalled();
        } finally {
          warnSpy.mockRestore();
          rmSync(configDir, { recursive: true, force: true });
        }
      },
    );

    it(
      'a read that TIMES OUT must NEVER cascade into minting a new key and overwriting the credential store — a genuinely existing key would be destroyed and the DB it encrypted permanently locked out',
      { timeout: CREDENTIAL_STORE_TIMEOUT_MS + 15_000 },
      async () => {
        const { getOrCreateKey, keyFilePath } = await import('../../src/storage/keystore.js');
        // Simulates "vault is slow but alive, and a real key genuinely
        // exists server-side, we just can't read it in time": every 'get'
        // hangs past the timeout; every 'set' succeeds FAST and records
        // what it was called with to a marker file. Before the
        // keystore-read-timeout follow-up fix, getOrCreateCredentialStoreKey
        // swallowed the scoped read's timeout as "no key found", fell
        // through the (also-timing-out) legacy read the same way, and then
        // called the fast-succeeding 'set' — MINTING a brand-new random key
        // and OVERWRITING whatever the real credential-store entry actually
        // held. This test proves that no longer happens: the mint/set path
        // must never be reached when a read timed out.
        const setMarkerPath = join(dir, 'set-calls.jsonl');
        const script = fixture(
          'timeout-cascade.cjs',
          [
            "const fs = require('node:fs');",
            "const [, , mode, service, account] = process.argv;",
            "if (mode === 'get') { setTimeout(() => process.exit(0), 120_000); }",
            'else if (mode === \'set\') {',
            "  const secret = fs.readFileSync(0, 'utf8');",
            `  fs.appendFileSync(${JSON.stringify(setMarkerPath)}, JSON.stringify({ service, account, secret }) + '\\n');`,
            '  process.exit(0);',
            '}',
          ].join('\n'),
        );
        __setChildScriptPathForTests(script);
        const configDir = mkdtempSync(join(tmpdir(), 'astra-keystore-timeout-cascade-'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const result = getOrCreateKey(configDir);

          // The safe outcome: fell back to key-file, exactly like a fully
          // unresponsive store would (see the test above) — NOT a
          // credential-store mint.
          expect(result.source).toBe('key-file');
          expect(readFileSync(keyFilePath(configDir), 'utf8').trim()).toBe(result.key);

          // The critical assertion: the destructive 'set' (mint) call was
          // NEVER made. If this fails, a read timeout is once again capable
          // of silently overwriting a real, already-in-use credential-store
          // entry.
          expect(existsSync(setMarkerPath)).toBe(false);
        } finally {
          warnSpy.mockRestore();
          rmSync(configDir, { recursive: true, force: true });
        }
      },
    );
  });
});
