// FEAT-449 — durable ingest spool: writer + reader helpers shared by the
// `capture claude` CLI (writer) and the daemon's spool-drain worker (reader).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readdirSync, readFileSync, rmSync, existsSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  spoolDir,
  spoolQuarantineDir,
  writeToSpool,
  listSpoolFiles,
  quarantineSpoolFile,
  deleteSpoolFile,
  readSpoolStats,
  pruneExpiredQuarantine,
  sweepQuarantineRedaction,
  DEFAULT_QUARANTINE_TTL_MS,
  MAX_WALK_DEPTH,
} from '../../src/ingest/spool.js';
import { redactSpooledEnvelope } from '../../src/ingest/spool-schema-guard.js';
import { drainIngestSpool } from '../../src/ingest/spool-drain.js';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { defaultConfig } from '../../src/config/config.js';

function makeDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// writeToSpool guards the key to a 64-char lowercase hex digest (defense in
// depth — the key becomes a filename segment). Real callers pass a SHA-256
// digest; tests mirror that with repeated-char hex strings so ordering is
// still obvious (K_A sorts before K_B).
const hx = (c: string): string => c.repeat(64);
const K_A = hx('a');
const K_B = hx('b');
const K_C = hx('c');
const K_D = hx('d');
const K_E = hx('e');
const K_F = hx('f');

const dirs: string[] = [];
function tempDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ingest-spool-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('writeToSpool — AC-2 (durable, atomic, idempotent)', () => {
  it('writes via tmp-file + rename — no leftover tmp file, content round-trips', () => {
    const dataDir = tempDataDir();
    const body = { event: 'subagent_stop', session_id: 'x', turns: [{ role: 'user', text: 'hi' }] };
    const path = writeToSpool(dataDir, K_A, body);

    expect(path).toBe(join(spoolDir(dataDir), `${K_A}.json`));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(body);

    // No leftover TMP artifact in the spool dir — `.stats.json` (A3's
    // cumulative spool-count sidecar, bumped by every writeToSpool call) is
    // a legitimate permanent dotfile, not a tmp leak, and listSpoolFiles()
    // already excludes it (dotfile-prefixed) same as any tmp file.
    const entries = readdirSync(spoolDir(dataDir));
    expect(entries.filter(n => n !== '.stats.json')).toEqual([`${K_A}.json`]);
    expect(entries.some(n => n.includes('.tmp'))).toBe(false);
  });

  it('re-writing the same key overwrites in place — does not duplicate', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_D, { v: 1 });
    writeToSpool(dataDir, K_D, { v: 2 });

    const files = listSpoolFiles(dataDir);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(files[0]!.path, 'utf8'))).toEqual({ v: 2 });
  });

  it('creates the spool dir on demand', () => {
    const dataDir = tempDataDir();
    expect(existsSync(spoolDir(dataDir))).toBe(false);
    writeToSpool(dataDir, K_C, { a: 1 });
    expect(existsSync(spoolDir(dataDir))).toBe(true);
  });

  it('rejects a non-hex key (defense-in-depth path-segment guard)', () => {
    const dataDir = tempDataDir();
    expect(() => writeToSpool(dataDir, '../escape', { a: 1 })).toThrow(/hex digest/);
    expect(() => writeToSpool(dataDir, 'too-short', { a: 1 })).toThrow(/hex digest/);
  });
});

describe('listSpoolFiles', () => {
  it('returns [] when the spool dir does not exist yet — not an error', () => {
    const dataDir = tempDataDir();
    expect(listSpoolFiles(dataDir)).toEqual([]);
  });

  it('lists .json files, sorted by key, excluding quarantine + dotfiles', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_B, { n: 2 });
    writeToSpool(dataDir, K_A, { n: 1 });

    const files = listSpoolFiles(dataDir);
    expect(files.map(f => f.key)).toEqual([K_A, K_B]);
    for (const f of files) expect(f.size).toBeGreaterThan(0);
  });
});

describe('quarantineSpoolFile — AC-5', () => {
  it('moves the file into .quarantine/ with a reason sidecar', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_E, { bad: true });
    const [file] = listSpoolFiles(dataDir);

    quarantineSpoolFile(dataDir, file!, 'oversize: 99 bytes exceeds cap');

    expect(listSpoolFiles(dataDir)).toEqual([]); // no longer drainable
    const qDir = join(spoolDir(dataDir), '.quarantine');
    expect(existsSync(join(qDir, `${K_E}.json`))).toBe(true);
    expect(readFileSync(join(qDir, `${K_E}.reason.txt`), 'utf8')).toContain('oversize');
  });

  it('is a no-op (does not throw) if the source file already vanished', () => {
    const dataDir = tempDataDir();
    expect(() => quarantineSpoolFile(dataDir, { path: join(dataDir, 'ingest-spool', 'gone.json'), key: 'gone', size: 0 }, 'race')).not.toThrow();
  });
});

describe('deleteSpoolFile', () => {
  it('removes a drained spool file', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_F, { ok: true });
    const [file] = listSpoolFiles(dataDir);
    deleteSpoolFile(file!);
    expect(listSpoolFiles(dataDir)).toEqual([]);
  });

  it('is a no-op (does not throw) if already gone', () => {
    const dataDir = tempDataDir();
    expect(() => deleteSpoolFile({ path: join(dataDir, 'ingest-spool', 'gone.json'), key: 'gone', size: 0 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wave A slice A3 — redact at spool-write
// ---------------------------------------------------------------------------

describe('redactSpooledEnvelope (schema-aware — third design, see src/ingest/spool-schema-guard.ts)', () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE'; // aws_access_key shape

  it('redacts turns[].text (still covers the shapes the old four-field allowlist covered)', () => {
    const config = defaultConfig();
    const body = { turns: [{ role: 'user', text: `key is ${SECRET}` }, { role: 'assistant', text: 'ok' }] };
    const out = redactSpooledEnvelope(body, config) as { turns: { role: string; text: string }[] };
    expect(out.turns[0]!.text).not.toContain(SECRET);
    expect(out.turns[0]!.text).toMatch(/\[REDACTED:aws_access_key:[0-9a-f]{8}\]/);
    expect(out.turns[1]!.text).toBe('ok'); // untouched — no secret present
  });

  it('redacts events[].text and events[].evidence (ADR-008 events kind)', () => {
    const config = defaultConfig();
    const body = { events: [{ type: 'fact', text: `saw ${SECRET}`, evidence: `log line: ${SECRET}` }] };
    const out = redactSpooledEnvelope(body, config) as { events: { text: string; evidence: string }[] };
    expect(out.events[0]!.text).not.toContain(SECRET);
    expect(out.events[0]!.evidence).not.toContain(SECRET);
  });

  it('redacts a legacy-shaped content field via the unknown-key fallback (LegacyIngestSchema is out of scope, but its content still isn\'t in CanonicalIngestSchema, so it falls to "unknown -> redact")', () => {
    const config = defaultConfig();
    const body = { session_id: 'x', source: 'y', content: `token=${SECRET}` };
    const out = redactSpooledEnvelope(body, config) as { content: string; session_id: string };
    expect(out.content).not.toContain(SECRET);
    expect(out.session_id).toBe('x'); // still protected — session_id IS in CanonicalIngestSchema's shape
  });

  it('review fix (coverage inversion, write-path counterpart of #230): redacts a secret in a field the schema never defines, at arbitrary depth', () => {
    // CanonicalIngestSchema validation happens at DRAIN time, not write
    // time, so writeToSpool never knows the envelope's shape is "valid" in
    // the first place. A key not in the schema's shape at all is treated
    // as unknown and redacted regardless of depth.
    const config = defaultConfig();
    const body = { debug: { upstream: { raw_headers: { authorization: `Bearer ${SECRET}` } } } };
    const out = redactSpooledEnvelope(body, config) as { debug: { upstream: { raw_headers: { authorization: string } } } };
    expect(out.debug.upstream.raw_headers.authorization).not.toContain(SECRET);
    expect(out.debug.upstream.raw_headers.authorization).toMatch(/\[REDACTED:aws_access_key:[0-9a-f]{8}\]/);
  });

  it('THE bug this design exists to fix: session_id (and other schema-known structural fields) survive untouched, even though session_id is exactly the shape the entropy detector flags', () => {
    // proxy-${randomUUID()} is the real shape (src/capture/proxy.ts
    // buildProxyEnvelope) — high-entropy, no internal whitespace, and
    // (confirmed by direct repro during review) reliably flagged by
    // findEntropySecrets when handed to redactIfEnabled directly. A bare
    // recursive redact-every-string walk destroys it; this one must not.
    const config = defaultConfig();
    const sessionId = `proxy-${randomUUID()}`;
    const body = {
      session_id: sessionId,
      project_id: 'llm-proxy',
      cwd: '/home/user/my-real-repo',
      agent_type: 'claude-code',
      event: 'session_end',
    };
    const out = redactSpooledEnvelope(body, config) as Record<string, string>;
    expect(out.session_id).toBe(sessionId);
    expect(out.project_id).toBe('llm-proxy');
    expect(out.cwd).toBe('/home/user/my-real-repo');
    expect(out.agent_type).toBe('claude-code');
    expect(out.event).toBe('session_end');
  });

  it('leaves object KEYS untouched — only values are ever redacted', () => {
    const config = defaultConfig();
    // A pathological key that itself looks secret-shaped — must never be
    // touched. Keys are structure, not content.
    const body = { [`AKIA${'X'.repeat(16)}`]: 'ordinary value' };
    const out = redactSpooledEnvelope(body, config) as Record<string, string>;
    expect(Object.keys(out)).toEqual([`AKIA${'X'.repeat(16)}`]);
  });

  it('leaves non-string primitives and non-object bodies untouched', () => {
    const config = defaultConfig();
    expect(redactSpooledEnvelope({ a: 1, b: true, c: null }, config)).toEqual({ a: 1, b: true, c: null });
    expect(redactSpooledEnvelope(42, config)).toBe(42);
    expect(redactSpooledEnvelope(null, config)).toBe(null);
    expect(redactSpooledEnvelope([1, 2, 3], config)).toEqual([1, 2, 3]);
  });

  it('is a no-op passthrough when security.redaction.enabled is false (SEC-9 parity with redactIfEnabled)', () => {
    const config = { ...defaultConfig(), security: { ...defaultConfig().security, redaction: { ...defaultConfig().security.redaction, enabled: false } } };
    const body = { turns: [{ role: 'user', text: `key is ${SECRET}` }] };
    const out = redactSpooledEnvelope(body, config) as { turns: { text: string }[] };
    expect(out.turns[0]!.text).toContain(SECRET); // unchanged — redaction explicitly off
  });

  it('does not mutate the input body', () => {
    const config = defaultConfig();
    const body = { turns: [{ role: 'user', text: `key is ${SECRET}` }] };
    const before = JSON.stringify(body);
    redactSpooledEnvelope(body, config);
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe('writeToSpool — A3 redacts before the bytes hit disk', () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';

  it('a secret in turns[].text never reaches the file written to disk', () => {
    const dataDir = tempDataDir();
    const body = { turns: [{ role: 'user', text: `export AWS_ACCESS_KEY_ID=${SECRET}` }] };
    const path = writeToSpool(dataDir, K_A, body, defaultConfig());

    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).toMatch(/\[REDACTED:aws_access_key:[0-9a-f]{8}\]/);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('defaults to defaultConfig() (redaction ON) when no config is passed — fail-safe, not fail-open', () => {
    const dataDir = tempDataDir();
    const body = { turns: [{ role: 'user', text: `export AWS_ACCESS_KEY_ID=${SECRET}` }] };
    const path = writeToSpool(dataDir, K_B, body); // no 4th arg
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('bumps SpoolStats.totalSpooled on every write — the doctor canary\'s denominator', () => {
    const dataDir = tempDataDir();
    expect(readSpoolStats(dataDir)).toEqual({ totalSpooled: 0, totalQuarantined: 0, statsHealthy: true });
    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    writeToSpool(dataDir, K_B, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    expect(readSpoolStats(dataDir).totalSpooled).toBe(2);
  });

  it('coverage-inversion fix: a secret in a field OUTSIDE the old four-field allowlist never reaches disk', () => {
    const dataDir = tempDataDir();
    // No turns/events/content — a shape CanonicalIngestSchema would reject
    // at drain time, but writeToSpool never validates the shape; it
    // redacts and writes unconditionally. The old redactSpoolEnvelope
    // allowlist had nothing to walk here; redactValuesDeep does.
    const body = {
      debug_headers: { authorization: `Bearer ${SECRET}` },
      raw: `upstream response included key=${SECRET}`,
    };
    const path = writeToSpool(dataDir, K_A, body, defaultConfig());
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).toMatch(/\[REDACTED:aws_access_key:[0-9a-f]{8}\]/);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('JSON-corruption fix AND session_id-survives fix: a realistic proxy-shaped envelope (real session_id, nested unrecognized fields, a real secret) writes safely to disk without corrupting the JSON or destroying the session identifier', () => {
    // Mirrors #230's round-2 fixture, plus the session_id assertion round
    // 2 of THIS design was missing. session_id: proxy-${randomUUID()} is
    // the exact shape every real proxy envelope has (src/capture/proxy.ts
    // buildProxyEnvelope) — a JSON value with no internal whitespace,
    // which is what made a naive "scan the serialized text" second pass
    // corrupt the JSON (swept the surrounding quotes and comma into the
    // entropy-matched span), AND independently high-entropy enough on its
    // own that a bare "redact every string" walk (this design's own first
    // attempt) destroyed it even once the JSON-corruption bug was fixed.
    const dataDir = tempDataDir();
    const sessionId = `proxy-${randomUUID()}`;
    const body = {
      event: 'session_end',
      session_id: sessionId,
      project_id: 'llm-proxy',
      captured_at: new Date().toISOString(),
      turns: [{ role: 'user', text: 'hello there' }],
      debug: { upstream: { raw_headers: { authorization: `Bearer ${SECRET}` } } },
    };
    const path = writeToSpool(dataDir, K_A, body, defaultConfig());
    const raw = readFileSync(path, 'utf8');

    expect(() => JSON.parse(raw)).not.toThrow(); // load-bearing: still valid JSON
    const parsed = JSON.parse(raw) as { session_id: string; debug: { upstream: { raw_headers: { authorization: string } } }; turns: Array<{ text: string }> };
    expect(raw).not.toContain(SECRET);
    expect(parsed.session_id).toBe(sessionId); // load-bearing: identity survived, not a [REDACTED:...] placeholder
    expect(parsed.debug.upstream.raw_headers.authorization).toMatch(/\[REDACTED:aws_access_key:[0-9a-f]{8}\]/);
    expect(parsed.turns[0]!.text).toBe('hello there'); // untouched — no secret, no entropy false-positive
  });

  it('idempotent: re-spooling already-redacted content does not double-redact or corrupt the placeholder', () => {
    const dataDir = tempDataDir();
    const body = { debug_headers: { authorization: `Bearer ${SECRET}` } };
    const firstPath = writeToSpool(dataDir, K_A, body, defaultConfig());
    const onceRedacted: unknown = JSON.parse(readFileSync(firstPath, 'utf8'));

    const secondPath = writeToSpool(dataDir, K_B, onceRedacted, defaultConfig());
    const twiceRedacted = readFileSync(secondPath, 'utf8');

    expect(twiceRedacted).not.toContain(SECRET);
    expect(() => JSON.parse(twiceRedacted)).not.toThrow();
    expect(twiceRedacted).toBe(readFileSync(firstPath, 'utf8')); // byte-identical — no double-redaction drift
  });
});

// ---------------------------------------------------------------------------
// Fast-follow to #225 (2026-07-13) — Finding 1: existing dirs kept loose
// perms, Finding 2: existing quarantine content kept plaintext, Finding 3:
// a lost .stats.json fabricated a green "0 of 0".
// ---------------------------------------------------------------------------

describe('Finding 1 — existing spool/quarantine dirs get hardened, not just newly-created ones', () => {
  it('a spool dir that predates the hardening (created with loose perms by hand) is hardened on the next write', () => {
    if (platform() === 'win32') return; // POSIX-only assertion — see existing "keystore-grade" describe block above
    const dataDir = tempDataDir();
    const dir = spoolDir(dataDir);
    // Simulate a pre-existing install: the directory already exists, with
    // permissive mode, from BEFORE restrictSpoolDirPermissions ever ran on
    // it — this is exactly the upgrade scenario Finding 1 is about.
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    expect(statSync(dir).mode & 0o777).toBe(0o755);

    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());

    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('a quarantine dir that predates the hardening is hardened on the next quarantine call', () => {
    if (platform() === 'win32') return;
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    const [file] = listSpoolFiles(dataDir);

    const qDir = spoolQuarantineDir(dataDir);
    mkdirSync(qDir, { recursive: true, mode: 0o755 });
    chmodSync(qDir, 0o755);
    expect(statSync(qDir).mode & 0o777).toBe(0o755);

    quarantineSpoolFile(dataDir, file!, 'test');

    expect(statSync(qDir).mode & 0o777).toBe(0o700);
  });
});

describe('review round 3 — a walk failure is NOT a parse failure', () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';

  // Regression guard for the bug that let rounds 1 and 2 both slip through:
  // `JSON.parse` and the value-walk used to share one try/catch, so a walk
  // that blew the stack on VALID JSON was silently reclassified as "this file
  // isn't JSON" and handed to the raw-text path — the exact corruption
  // mechanism round 2 fixed. Two different failures; one of them has a
  // recovery that is destructive to the other.
  //
  // NOTE ON WHY THIS ASSERTS AGAINST MAX_WALK_DEPTH AND NOT THE REAL STACK:
  // vitest's worker pool has a DEEPER stack than the daemon (`node
  // dist/cli/index.js serve`), so a test that waits for a genuine RangeError
  // would pass here and still overflow in production. The cap must be a number
  // we chose, and the test must assert against that number.
  const deeplyNested = (depth: number): unknown => {
    let node: unknown = { text: `export AWS_ACCESS_KEY_ID=${SECRET}` };
    for (let i = 0; i < depth; i++) node = { nested: node };
    return node;
  };

  it('valid JSON past MAX_WALK_DEPTH is left EXACTLY as-is — not raw-text-mangled, not counted as redacted', () => {
    const dataDir = tempDataDir();
    const qDir = spoolQuarantineDir(dataDir);
    mkdirSync(qDir, { recursive: true });
    const original = JSON.stringify(deeplyNested(MAX_WALK_DEPTH + 50), null, 2);
    writeFileSync(join(qDir, `${K_A}.json`), original);

    const result = sweepQuarantineRedaction(dataDir, defaultConfig());

    expect(result.scanned).toBe(1);
    expect(result.unwalkable).toBe(1);
    // Not silently claimed as a success...
    expect(result.redacted).toBe(0);
    // ...and NOT misfiled as "wasn't JSON" — it was perfectly valid JSON.
    expect(result.unparseable).toBe(0);

    // The file is byte-identical. Pre-fix, it went down the raw-text path and
    // came back mangled (or silently under-redacted) while reporting success.
    const after = readFileSync(join(qDir, `${K_A}.json`), 'utf8');
    expect(after).toBe(original);
    expect(() => JSON.parse(after)).not.toThrow();
  });

  it('a file just UNDER the cap is still walked and redacted normally', () => {
    const dataDir = tempDataDir();
    const qDir = spoolQuarantineDir(dataDir);
    mkdirSync(qDir, { recursive: true });
    writeFileSync(join(qDir, `${K_A}.json`), JSON.stringify(deeplyNested(MAX_WALK_DEPTH - 5), null, 2));

    const result = sweepQuarantineRedaction(dataDir, defaultConfig());

    expect(result.unwalkable).toBe(0);
    expect(result.redacted).toBe(1);
    const after = readFileSync(join(qDir, `${K_A}.json`), 'utf8');
    expect(after).not.toContain(SECRET);
    expect(() => JSON.parse(after)).not.toThrow(); // still valid JSON
  });
});

describe('Finding 2 — sweepQuarantineRedaction redacts pre-existing quarantine content in place', () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';

  it('redacts a secret in a well-formed pre-existing quarantine file, and does not lose the file', () => {
    const dataDir = tempDataDir();
    // Bypass writeToSpool's own redaction to simulate content that was
    // quarantined BEFORE #225 shipped redact-at-spool-write — i.e. genuinely
    // unredacted plaintext already sitting in .quarantine/.
    const qDir = spoolQuarantineDir(dataDir);
    mkdirSync(qDir, { recursive: true });
    const envelope = { turns: [{ role: 'user', text: `export AWS_ACCESS_KEY_ID=${SECRET}` }] };
    writeFileSync(join(qDir, `${K_A}.json`), JSON.stringify(envelope, null, 2));

    const result = sweepQuarantineRedaction(dataDir, defaultConfig());

    expect(result.scanned).toBe(1);
    expect(result.redacted).toBe(1);
    expect(result.unparseable).toBe(0);
    expect(result.failed).toBe(0);
    expect(existsSync(join(qDir, `${K_A}.json`))).toBe(true); // file preserved
    const rewritten = readFileSync(join(qDir, `${K_A}.json`), 'utf8');
    expect(rewritten).not.toContain(SECRET);
    expect(rewritten).toMatch(/\[REDACTED:aws_access_key:[0-9a-f]{8}\]/);
    expect(() => JSON.parse(rewritten)).not.toThrow(); // "did the secret go" is not enough — "is it still a file"
  });

  it('review fix round 2 (JSON corruption): a realistic proxy-shaped envelope (session_id, nested unrecognized fields, a real secret) redacts safely without corrupting the JSON', () => {
    // Round 1 fixed the coverage inversion by adding a second pass that ran
    // redactIfEnabled over the fully SERIALIZED envelope text. That broke on
    // exactly this shape: every real proxy envelope has a `session_id:
    // proxy-${randomUUID()}` field (src/capture/proxy.ts buildProxyEnvelope).
    // In pretty-printed JSON that value has no internal whitespace, so the
    // entropy detector's whitespace tokenizer swept the surrounding quotes
    // AND trailing comma into the "secret" span and replaced the whole thing
    // with a bare, unquoted placeholder — corrupting the JSON while the
    // sweep still reported `redacted: 1` (success). This is the fixture that
    // proves round 2 (redactValuesDeep, walking the decoded value tree
    // instead of scanning serialized text) actually closes that.
    const dataDir = tempDataDir();
    const qDir = spoolQuarantineDir(dataDir);
    mkdirSync(qDir, { recursive: true });
    const envelope = {
      event: 'session_end',
      session_id: `proxy-${randomUUID()}`, // the exact FP-prone shape that corrupted round 1
      project_id: 'llm-proxy',
      captured_at: new Date().toISOString(),
      turns: [{ role: 'user', text: 'hello there' }],
      // A real secret in a field CanonicalIngestSchema/redactSpoolEnvelope's
      // allowlist has never heard of — the coverage-inversion case, nested
      // two levels deep to also prove recursion.
      debug: { upstream: { raw_headers: { authorization: `Bearer ${SECRET}` } } },
    };
    writeFileSync(join(qDir, `${K_A}.json`), JSON.stringify(envelope, null, 2));

    const result = sweepQuarantineRedaction(dataDir, defaultConfig());
    expect(result.scanned).toBe(1);
    expect(result.unparseable).toBe(0);
    expect(result.failed).toBe(0);

    const rewritten = readFileSync(join(qDir, `${K_A}.json`), 'utf8');
    // The load-bearing assertion: still valid, parseable JSON. This is the
    // one that would have caught round 1's bug — "did the secret go" was
    // never sufficient on its own.
    expect(() => JSON.parse(rewritten)).not.toThrow();
    const parsedEnvelope = JSON.parse(rewritten) as { debug: { upstream: { raw_headers: { authorization: string } } }; turns: Array<{ text: string }> };
    expect(rewritten).not.toContain(SECRET);
    expect(parsedEnvelope.debug.upstream.raw_headers.authorization).toMatch(/\[REDACTED:aws_access_key:[0-9a-f]{8}\]/);
    expect(parsedEnvelope.turns[0]!.text).toBe('hello there'); // untouched — no secret, no entropy false-positive here
  });

  it('review fix (coverage inversion): a well-formed but schema-invalid envelope with a secret in an UNRECOGNIZED field is still redacted', () => {
    // The dominant quarantine population (spool-drain.ts) is valid JSON
    // that fails CanonicalIngestSchema — a reshaped, legacy-drifted, or
    // debug-augmented envelope. redactSpoolEnvelope only walks a four-field
    // allowlist (turns[].text, events[].text/evidence, content); a stray
    // field like `debug_headers` or `raw` spreads through untouched via
    // `{...rec}`. This is the case the first cut of sweepQuarantineRedaction
    // missed — it routed every PARSEABLE file through redactSpoolEnvelope
    // alone, so a secret sitting in a field the allowlist doesn't recognize
    // survived, and because the bytes didn't change, the `redacted` counter
    // never incremented either (a silent miss, not just a missed redaction).
    const dataDir = tempDataDir();
    const qDir = spoolQuarantineDir(dataDir);
    mkdirSync(qDir, { recursive: true });
    const envelope = {
      // Not a shape CanonicalIngestSchema accepts — no turns/events/content,
      // just an unrecognized debug field a broken/reshaping client tacked
      // on. redactSpoolEnvelope's allowlist has nothing to walk here.
      debug_headers: { authorization: `Bearer ${SECRET}` },
      raw: `upstream response included key=${SECRET}`,
    };
    writeFileSync(join(qDir, `${K_A}.json`), JSON.stringify(envelope, null, 2));

    const result = sweepQuarantineRedaction(dataDir, defaultConfig());

    expect(result.scanned).toBe(1);
    expect(result.unparseable).toBe(0); // it DID parse — this is the parseable-but-invalid case
    expect(result.redacted).toBe(1); // must be counted, not silently skipped
    expect(existsSync(join(qDir, `${K_A}.json`))).toBe(true);
    const rewritten = readFileSync(join(qDir, `${K_A}.json`), 'utf8');
    expect(rewritten).not.toContain(SECRET);
    expect(rewritten).toMatch(/\[REDACTED:aws_access_key:[0-9a-f]{8}\]/);
    expect(() => JSON.parse(rewritten)).not.toThrow();
  });

  it('is idempotent — a second sweep over already-redacted content is a no-op write', () => {
    const dataDir = tempDataDir();
    const qDir = spoolQuarantineDir(dataDir);
    mkdirSync(qDir, { recursive: true });
    const envelope = { turns: [{ role: 'user', text: `export AWS_ACCESS_KEY_ID=${SECRET}` }] };
    writeFileSync(join(qDir, `${K_A}.json`), JSON.stringify(envelope, null, 2));

    sweepQuarantineRedaction(dataDir, defaultConfig());
    const afterFirst = readFileSync(join(qDir, `${K_A}.json`), 'utf8');
    expect(() => JSON.parse(afterFirst)).not.toThrow();

    const second = sweepQuarantineRedaction(dataDir, defaultConfig());
    expect(second.scanned).toBe(1);
    expect(second.redacted).toBe(0); // nothing changed — already redacted
    expect(readFileSync(join(qDir, `${K_A}.json`), 'utf8')).toBe(afterFirst);
  });

  it('leaves files with no secret content untouched (no unnecessary write)', () => {
    const dataDir = tempDataDir();
    const qDir = spoolQuarantineDir(dataDir);
    mkdirSync(qDir, { recursive: true });
    const envelope = { turns: [{ role: 'user', text: 'nothing sensitive here' }] };
    const raw = JSON.stringify(envelope, null, 2);
    writeFileSync(join(qDir, `${K_A}.json`), raw);

    const result = sweepQuarantineRedaction(dataDir, defaultConfig());
    expect(result.redacted).toBe(0);
    expect(readFileSync(join(qDir, `${K_A}.json`), 'utf8')).toBe(raw);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('an unparseable quarantine file is redacted via the raw-text fallback — the secret does not survive, and the file is not deleted', () => {
    const dataDir = tempDataDir();
    const qDir = spoolQuarantineDir(dataDir);
    mkdirSync(qDir, { recursive: true });
    // Deliberately broken JSON (truncated) — this is what a schema-validation
    // or JSON.parse failure actually looks like on disk, per spool-drain.ts.
    const brokenRaw = `{"turns": [{"role": "user", "text": "export AWS_ACCESS_KEY_ID=${SECRET}"` /* truncated, no closing */;
    writeFileSync(join(qDir, `${K_A}.json`), brokenRaw);

    const result = sweepQuarantineRedaction(dataDir, defaultConfig());

    expect(result.scanned).toBe(1);
    expect(result.redacted).toBe(1);
    expect(result.unparseable).toBe(1);
    expect(result.failed).toBe(0);
    expect(existsSync(join(qDir, `${K_A}.json`))).toBe(true); // not deleted
    const rewritten = readFileSync(join(qDir, `${K_A}.json`), 'utf8');
    expect(rewritten).not.toContain(SECRET);
    expect(rewritten).toMatch(/\[REDACTED:aws_access_key:[0-9a-f]{8}\]/);
  });

  it('returns all-zero on a missing quarantine dir — not an error', () => {
    const dataDir = tempDataDir();
    expect(sweepQuarantineRedaction(dataDir, defaultConfig())).toEqual({ scanned: 0, redacted: 0, unparseable: 0, failed: 0, unwalkable: 0 });
  });

  it('leaves the .reason.txt sidecar alone (out of scope for this sweep) while redacting the envelope', () => {
    const dataDir = tempDataDir();
    const qDir = spoolQuarantineDir(dataDir);
    mkdirSync(qDir, { recursive: true });
    const envelope = { turns: [{ role: 'user', text: `key ${SECRET}` }] };
    writeFileSync(join(qDir, `${K_A}.json`), JSON.stringify(envelope, null, 2));
    writeFileSync(join(qDir, `${K_A}.reason.txt`), 'schema validation failed\n');

    sweepQuarantineRedaction(dataDir, defaultConfig());

    expect(readFileSync(join(qDir, `${K_A}.reason.txt`), 'utf8')).toBe('schema validation failed\n');
    expect(() => JSON.parse(readFileSync(join(qDir, `${K_A}.json`), 'utf8'))).not.toThrow();
  });
});

describe('Finding 3 — SpoolStats.statsHealthy distinguishes a real zero from an unreadable counter', () => {
  it('statsHealthy is true on a genuinely fresh (no spool dir) install', () => {
    const dataDir = tempDataDir();
    expect(readSpoolStats(dataDir)).toEqual({ totalSpooled: 0, totalQuarantined: 0, statsHealthy: true });
  });

  it('statsHealthy is true once .stats.json parses successfully', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    expect(readSpoolStats(dataDir).statsHealthy).toBe(true);
  });

  it('statsHealthy is false when .stats.json is corrupt but the spool dir has other content', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    // Corrupt the stats file in place, as a torn write would leave it.
    writeFileSync(join(spoolDir(dataDir), '.stats.json'), '{not json');

    const stats = readSpoolStats(dataDir);
    expect(stats.statsHealthy).toBe(false);
    expect(stats.totalSpooled).toBe(0); // still reads back as 0 — statsHealthy is what makes 0 distinguishable from unknown
  });

  it('statsHealthy is true when .stats.json is corrupt but the spool dir is otherwise empty (nothing to lose track of)', () => {
    const dataDir = tempDataDir();
    mkdirSync(spoolDir(dataDir), { recursive: true });
    writeFileSync(join(spoolDir(dataDir), '.stats.json'), '{not json');

    expect(readSpoolStats(dataDir).statsHealthy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE test that actually proves this fix (team-lead requirement) — a
// redaction-only unit test structurally cannot: it never crosses the
// schema-validation/session-upsert boundary where the bare-walk regression
// actually did its damage. This one does: real spool file -> real
// drainIngestSpool -> real CanonicalIngestSchema.safeParse -> real
// ingestCanonicalTranscript -> real DB rows.
// ---------------------------------------------------------------------------

describe('round-trip: spool -> drain -> DB', () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';

  it('a secret in an unknown field is gone from the drained transcript, and session_id survives intact through the schema boundary and the session upsert', () => {
    const dataDir = tempDataDir();
    const db = makeDb();
    const config = defaultConfig();
    const sessionId = `proxy-${randomUUID()}`;
    const body = {
      event: 'session_end',
      session_id: sessionId,
      project_id: 'llm-proxy',
      captured_at: new Date().toISOString(),
      client_scrub_applied: false,
      client_scrub_hits: 0,
      client_version: '9.9.9',
      client_scrub_version: 'none',
      wire_version: 'v1.0',
      turns: [{ role: 'user', text: 'hello there' }],
      // The unrecognized field — CanonicalIngestSchema has never heard of
      // `debug`, so it strips silently at drain-time parse (zod's default
      // STRIP mode) — but that happens AFTER this write, and the whole
      // point of this fix is that the secret must never reach disk in the
      // window before that strip happens, whether or not drain later
      // discards the field entirely.
      debug: { upstream: { raw_headers: { authorization: `Bearer ${SECRET}` } } },
    };

    try {
      writeToSpool(dataDir, K_A, body, config);

      // Prove the secret never reached disk in the first place — the
      // strongest form of this assertion, independent of what drain does
      // with the (redacted) unknown field afterward.
      const spooled = listSpoolFiles(dataDir);
      expect(spooled).toHaveLength(1);
      expect(readFileSync(spooled[0]!.path, 'utf8')).not.toContain(SECRET);

      const result = drainIngestSpool(db, config, dataDir);
      expect(result).toEqual({ drained: 1, quarantined: 0, pending: 0 });

      const sessionRow = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId) as { id: string } | undefined;
      expect(sessionRow?.id).toBe(sessionId); // THE assertion: session identity, not a redaction placeholder

      const transcriptRow = db.prepare('SELECT session_id, content FROM transcripts WHERE session_id = ?').get(sessionId) as
        | { session_id: string; content: string }
        | undefined;
      expect(transcriptRow?.session_id).toBe(sessionId);
      expect(transcriptRow?.content).not.toContain(SECRET);
    } finally {
      db.close();
    }
  });
});

describe('spool + quarantine directory permissions (keystore-grade)', () => {
  it('the spool dir is created with restrictive permissions', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    const dir = spoolDir(dataDir);
    expect(existsSync(dir)).toBe(true);
    if (platform() !== 'win32') {
      // POSIX: 0700 — non-owners cannot even traverse into the directory,
      // which protects every file inside regardless of each file's own mode.
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    // Windows: best-effort icacls — asserted only by "did not throw and the
    // directory exists" here, same posture as the untested
    // restrictKeyFileAcl in src/storage/keystore.ts (no CI-portable way to
    // assert a real ACL was applied without shelling out to icacls /Q in the
    // test itself, which the source-level warn-on-failure already covers).
  });

  it('the quarantine dir is created with restrictive permissions', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    const [file] = listSpoolFiles(dataDir);
    quarantineSpoolFile(dataDir, file!, 'test');
    const qDir = spoolQuarantineDir(dataDir);
    expect(existsSync(qDir)).toBe(true);
    if (platform() !== 'win32') {
      expect(statSync(qDir).mode & 0o777).toBe(0o700);
    }
  });
});

describe('pruneExpiredQuarantine — quarantine TTL', () => {
  it('removes a quarantine file (and its .reason.txt sidecar) older than maxAgeMs', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    const [file] = listSpoolFiles(dataDir);
    quarantineSpoolFile(dataDir, file!, 'aged out');

    const qDir = spoolQuarantineDir(dataDir);
    const jsonPath = join(qDir, `${K_A}.json`);
    const reasonPath = join(qDir, `${K_A}.reason.txt`);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(reasonPath)).toBe(true);

    // Backdate the file's mtime past a short TTL rather than sleeping in
    // the test — utimesSync takes seconds-since-epoch for both atime/mtime.
    const oldTime = (Date.now() - 1000) / 1000;
    utimesSync(jsonPath, oldTime, oldTime);

    const result = pruneExpiredQuarantine(dataDir, 500); // 500ms TTL — the file is ~1000ms old
    expect(result).toEqual({ removed: 1, remaining: 0 });
    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(reasonPath)).toBe(false);
  });

  it('leaves a quarantine file younger than maxAgeMs untouched', () => {
    const dataDir = tempDataDir();
    writeToSpool(dataDir, K_A, { turns: [{ role: 'user', text: 'hi' }] }, defaultConfig());
    const [file] = listSpoolFiles(dataDir);
    quarantineSpoolFile(dataDir, file!, 'fresh');

    const result = pruneExpiredQuarantine(dataDir, DEFAULT_QUARANTINE_TTL_MS);
    expect(result).toEqual({ removed: 0, remaining: 1 });
    expect(existsSync(join(spoolQuarantineDir(dataDir), `${K_A}.json`))).toBe(true);
  });

  it('is a no-op (not an error) when the quarantine dir does not exist yet', () => {
    const dataDir = tempDataDir();
    expect(pruneExpiredQuarantine(dataDir)).toEqual({ removed: 0, remaining: 0 });
  });

  it('uses the 7-day DEFAULT_QUARANTINE_TTL_MS when maxAgeMs is omitted', () => {
    expect(DEFAULT_QUARANTINE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
