/**
 * FEAT-458 S3 — ADR-013 Decision 1 (Information Disclosure row) / Decision 4
 * / review decision 3: "the capture fork's input type carries body-only
 * fields (no headers field exists to leak), plus a test asserting a canary
 * header injected at the proxy never appears in any spool write." This is
 * that test — the one that would have caught the exact disaster class this
 * ADR exists to prevent.
 *
 * Routes REAL traffic through the REAL proxy (src/proxy/server.ts) with the
 * REAL capture fork (src/capture/proxy.ts) attached via `createTee`, against
 * a fake upstream that itself echoes credential-shaped values back in
 * RESPONSE headers too — so this proves exclusion in both directions, not
 * just the request side. The canary values are injected ONLY in headers,
 * never anywhere in either body, so any appearance of a canary string
 * anywhere under the spool directory (recursively, including
 * `.quarantine/`) is unambiguous proof of a header leak — there is no
 * legitimate way for it to get there.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startProxyServer, type ProxyHandle } from '../../src/proxy/server.js';
import { createProxyCaptureTee } from '../../src/capture/proxy.js';
import { listSpoolFiles } from '../../src/ingest/spool.js';

const REQUEST_CANARY = 'sk-REQUEST-CANARY-do-not-leak-777';
const RESPONSE_CANARY = 'sk-RESPONSE-CANARY-do-not-leak-999';
const GATE_OPTS = { minChars: 1, maxBytes: 1_000_000, dedupWindow: 20 };

/** Every file under dataDir, recursively — spool files AND anything that
 *  ever landed in .quarantine/, so a canary that leaked into a poison file
 *  (rather than a successful spool write) is caught too. */
function allFilesRecursive(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...allFilesRecursive(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function listenEphemeral(server: Server): Promise<number> {
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)).then(() => {
    const addr = server.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    return addr.port;
  });
}

describe('canary header exclusion — headers structurally never reach the spool', () => {
  let fakeUpstream: Server | undefined;
  let proxy: ProxyHandle | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
    if (fakeUpstream) await new Promise<void>((resolve) => fakeUpstream!.close(() => resolve()));
    fakeUpstream = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it('a canary Authorization value + a canary response header never appear anywhere under the spool dir, while the actual body content DOES get captured', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'astramem-canary-test-'));

    fakeUpstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        // Sanity: the canary DID reach the upstream unchanged (ADR-013
        // Decision 4 — provider keys are forwarded, never inspected) — if
        // this assertion ever fails, the test setup itself is broken, not
        // the property under test.
        expect(req.headers['authorization']).toBe(`Bearer ${REQUEST_CANARY}`);
        res.writeHead(200, {
          'content-type': 'application/json',
          // A response header that must ALSO never reach the capture fork —
          // ADR-013's exclusion is bidirectional (Decision 4 covers both
          // request and response headers).
          'x-canary-response': RESPONSE_CANARY,
        });
        res.end(JSON.stringify({
          id: 'chatcmpl-canary',
          choices: [{ message: { role: 'assistant', content: 'The daemon listens on port 7777 by default.' } }],
        }));
      });
    });
    const upstreamPort = await listenEphemeral(fakeUpstream);

    const createTee = createProxyCaptureTee({ dataDir, clientVersion: '9.9.9', relevanceGate: GATE_OPTS });
    proxy = await startProxyServer({
      port: 0, host: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}`, createTee,
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${REQUEST_CANARY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'what port does the daemon listen on' }],
      }),
    });
    // Prove the canary reached the client response header too (forwarded
    // unchanged, per ADR-013 Decision 4) — again, setup sanity, not the
    // property under test.
    expect(res.headers.get('x-canary-response')).toBe(RESPONSE_CANARY);
    await res.text();

    // The spool write is deferred via setImmediate off the pipe-completion
    // path (ADR-013 Decision 3) — flush past that before asserting.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20)); // small margin for CI jitter

    const spoolDir = join(dataDir, 'ingest-spool');
    const files = allFilesRecursive(spoolDir);
    expect(files.length).toBeGreaterThan(0); // sanity: something WAS captured

    for (const path of files) {
      const raw = readFileSync(path, 'utf8');
      expect(raw).not.toContain(REQUEST_CANARY);
      expect(raw).not.toContain(RESPONSE_CANARY);
      // Belt-and-suspenders: neither canary's bearer-token PREFIX either, in
      // case a future change truncates/reformats before writing.
      expect(raw.toLowerCase()).not.toContain('authorization');
      expect(raw.toLowerCase()).not.toContain('x-canary-response');
    }

    // Positive control: the actual BODY content (never a header) made it
    // through, proving this isn't a trivially-passing "nothing captured"
    // false negative.
    const spooled = listSpoolFiles(dataDir);
    expect(spooled).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(spooled[0]!.path, 'utf8')) as { turns: Array<{ role: string; text: string }> };
    expect(envelope.turns).toEqual([
      { role: 'user', text: 'what port does the daemon listen on' },
      { role: 'assistant', text: 'The daemon listens on port 7777 by default.' },
    ]);
  });

  it('src/capture/proxy.ts never references headers in CODE (comments may discuss the exclusion in prose)', () => {
    // Belt-and-suspenders alongside the type boundary (ProxyTeeEvent has no
    // headers field, checked by `tsc -p .` on every build) — this catches
    // an `as any`/`as unknown as X` escape hatch a future edit could use to
    // route around the type system without the compiler ever objecting.
    // Vitest/esbuild strip types at test-run time (no type-check gate on
    // this file), so the type boundary alone isn't enforced by `vitest run`
    // — this scan is the check that actually runs every time. Comments are
    // stripped before matching — the file's own doc comments legitimately
    // explain the exclusion in English (the word "headers" appears in
    // prose); what must never appear is the word in actual CODE.
    const raw = readFileSync(resolve(__dirname, '..', '..', 'src', 'capture', 'proxy.ts'), 'utf8');
    const codeOnly = raw
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/\/\/.*$/gm, '');        // line comments
    expect(codeOnly.toLowerCase()).not.toContain('headers');
  });
});
