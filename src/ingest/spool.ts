/**
 * Durable ingest spool (FEAT-449) — shared path/write/list/quarantine
 * helpers for the `capture claude` CLI (writer, src/cli/capture.ts) and the
 * daemon's spool-drain worker (reader, src/ingest/spool-drain.ts).
 *
 * Captured envelope CONTENT is written here atomically (tmp-file + rename —
 * never a torn file) at capture time, decoupled from the daemon's
 * availability: AC-8 — a capture that runs while the daemon is stopped still
 * leaves a durable spool file, drained on the daemon's next tick once it
 * starts. AC-2 — the filename IS the idempotency key (a content hash), so
 * re-capturing unmodified content overwrites the same path rather than
 * accumulating duplicates.
 *
 * Wave A slice A3 (2026-07-13): previously the daemon's stage-0 ingest
 * (`redactIfEnabled` in src/server/routes/ingest.ts) was the ONLY redaction
 * choke point — meaning envelopes sat on disk here, in plaintext, from
 * capture time until the drain worker got to them. Worse, a file that failed
 * `CanonicalIngestSchema.safeParse` at drain time (src/ingest/spool-drain.ts)
 * was moved to `.quarantine/` WITHOUT ever reaching that choke point — and
 * content that breaks a parser disproportionately correlates with secrets
 * and control characters, making quarantine the single most likely place on
 * disk for a live credential to sit indefinitely. `writeToSpool` now redacts
 * (`redactSpoolEnvelope`, reusing the exact `redactIfEnabled` choke point)
 * BEFORE the bytes ever hit disk — every spooled envelope is redacted
 * up front, whether it later drains cleanly or gets quarantined. The spool
 * and quarantine directories also get keystore-grade permissions
 * (`restrictSpoolDirPermissions`, mirroring `src/storage/keystore.ts`'s
 * `restrictKeyFileAcl`), and quarantined files now expire
 * (`pruneExpiredQuarantine`, called once per drain tick from
 * spool-drain.ts) rather than accumulating forever with no TTL.
 *
 * Fast-follow (2026-07-13): the above only protects NEW state. Three gaps in
 * what was already on disk before it shipped:
 *  (1) `restrictSpoolDirPermissions` only ran inside `if (!existsSync(dir))`
 *      — an install that already had `ingest-spool/`/`.quarantine/` on disk
 *      never got hardened on upgrade. Now called unconditionally (memoized
 *      per-process via `ensureSpoolDirPermissions`) from both `writeToSpool`
 *      and `quarantineSpoolFile`.
 *  (2) Content already sitting in `.quarantine/` from before this redaction
 *      choke point existed was never redacted — only the 7-day TTL sweep
 *      would eventually remove it, and only if a drain tick ever ran.
 *      `sweepQuarantineRedaction`, called once per daemon boot from
 *      `serve.ts`, rewrites existing quarantine content through the same
 *      redactor in place.
 *  (3) `SpoolStats` (below) gained `statsHealthy` — a missing/corrupt
 *      `.stats.json` with real spool activity on disk must not read back
 *      as a fabricated "0 of 0" (ADR-015 rule 6).
 */
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { platform } from 'node:os';
import { defaultConfig, type Config } from '../config/config.js';
import { redactIfEnabled } from '../redact/index.js';

export function spoolDir(dataDir: string): string {
  return join(dataDir, 'ingest-spool');
}

export function spoolQuarantineDir(dataDir: string): string {
  return join(spoolDir(dataDir), '.quarantine');
}

function spoolStatsPath(dataDir: string): string {
  return join(spoolDir(dataDir), '.stats.json');
}

export interface SpoolStats {
  /** Cumulative count of envelopes ever written via writeToSpool — the
   *  denominator for the doctor quarantine canary (ADR-015 rule 6: state the
   *  denominator, not a bare count). Never decremented — this is a lifetime
   *  counter, not a current-depth gauge (listSpoolFiles/readdir already give
   *  current depth). */
  totalSpooled: number;
  /** Cumulative count of envelopes ever quarantined. */
  totalQuarantined: number;
  /**
   * False when `.stats.json` is missing/corrupt AND there is independent
   * on-disk evidence the spool has actually been used (the spool dir holds
   * something besides the stats file itself). In that combination the
   * counter is not "genuinely zero," it is unreadable — ADR-015 rule 6:
   * "0 of 0" must never render identically to "denominator unknown." A
   * fresh install (spool dir absent, or present but otherwise empty) is
   * `true` — a missing counter there IS a real zero, not a broken one.
   */
  statsHealthy: boolean;
}

/** Best-effort read — a missing/corrupt stats file (e.g. a fresh install, or
 *  a torn write from a killed process — this file is NOT written via the
 *  tmp+rename atomic pattern, since it's observability, not durable content)
 *  reads back as zeros rather than throwing. See `SpoolStats.statsHealthy`
 *  doc for why a corrupt-but-otherwise-empty spool dir still counts as
 *  healthy while a corrupt-and-non-empty one does not. */
export function readSpoolStats(dataDir: string): SpoolStats {
  try {
    const parsed = JSON.parse(readFileSync(spoolStatsPath(dataDir), 'utf8')) as Partial<SpoolStats>;
    return {
      totalSpooled: typeof parsed.totalSpooled === 'number' ? parsed.totalSpooled : 0,
      totalQuarantined: typeof parsed.totalQuarantined === 'number' ? parsed.totalQuarantined : 0,
      statsHealthy: true,
    };
  } catch {
    let hasOtherContent = false;
    try {
      hasOtherContent = readdirSync(spoolDir(dataDir)).some(name => name !== '.stats.json');
    } catch {
      hasOtherContent = false; // spool dir doesn't exist at all — genuinely fresh
    }
    return { totalSpooled: 0, totalQuarantined: 0, statsHealthy: !hasOtherContent };
  }
}

/** Best-effort increment — a stats-file write failure must never break the
 *  spool write/quarantine path it's merely observing. Not safe against
 *  concurrent-writer races (a lost increment under true concurrency is
 *  acceptable for an observability counter; it is never read as an exact
 *  audit trail, only as ADR-015's "state the denominator" doctor signal). */
function bumpSpoolStat(dataDir: string, field: 'totalSpooled' | 'totalQuarantined'): void {
  try {
    const dir = spoolDir(dataDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stats = readSpoolStats(dataDir);
    stats[field] += 1;
    writeFileSync(spoolStatsPath(dataDir), JSON.stringify({ totalSpooled: stats.totalSpooled, totalQuarantined: stats.totalQuarantined }), { mode: 0o600 });
  } catch {
    /* best-effort telemetry only */
  }
}

/**
 * Keystore-grade directory permissions (mirrors `src/storage/keystore.ts`'s
 * `restrictKeyFileAcl` pattern exactly — same rationale: chmod alone is a
 * no-op on Windows, so a real ACL is required there). POSIX: 0700 on the
 * directory is sufficient on its own — new files inherit no special mode,
 * but nothing outside the owning account can even traverse into the
 * directory to read them, regardless of each file's own bits. Windows: no
 * directory-mode equivalent exists, so `/inheritance:r /grant:r
 * <user>:(OI)(CI)F` strips inherited ACEs and grants the current user full
 * control with object+container inheritance — every file written into this
 * directory afterward inherits the restricted ACL automatically, so this
 * only needs to run once per directory (at creation), not per file.
 * Best-effort but LOUD on failure, same posture as keystore.ts: a spool
 * directory without a real ACL is a security downgrade the operator must
 * know about, not a silent skip.
 */
/**
 * Process-lifetime memo of directories already hardened by this process.
 * Finding 1 (2026-07-13 fast-follow): the original call sites only ever ran
 * `restrictSpoolDirPermissions` inside `if (!existsSync(dir))` — i.e. only
 * at first-ever creation. Every install that predates this hardening
 * already has an `ingest-spool/` (and often a `.quarantine/`) on disk, so
 * upgrading never locked those down. `ensureSpoolDirPermissions` below is
 * called UNCONDITIONALLY from both `writeToSpool` and `quarantineSpoolFile`
 * — including when the directory already existed — so a pre-existing loose
 * directory gets hardened on the very next write/quarantine after upgrade.
 *
 * Chose per-process memoization over a separate once-per-drain-tick sweep
 * because `writeToSpool` is called from TWO call sites with different
 * lifetimes: `cli/capture.ts` is a short-lived process (one call = one
 * process, so "once per process" costs exactly what "per write" would have
 * cost anyway), and `capture/proxy.ts` runs IN the long-lived daemon
 * process, on every proxied request via `setImmediate` — a hot path where
 * `icacls` (win32) spawning a child process on every single call would be a
 * real, unbounded cost. A once-per-drain-tick sweep would also miss the
 * proxy write path entirely, since draining only touches `quarantineSpoolFile`,
 * not `writeToSpool`. POSIX `chmodSync` is a single cheap syscall either way
 * (safe to call unconditionally with no memo), but the memo is applied
 * uniformly on both platforms so the two code paths stay identical and the
 * win32 cost reasoning above holds without a platform branch at the call site.
 */
const hardenedDirsThisProcess = new Set<string>();

function ensureSpoolDirPermissions(dir: string): void {
  if (hardenedDirsThisProcess.has(dir)) return;
  restrictSpoolDirPermissionsUnmemoized(dir);
  hardenedDirsThisProcess.add(dir); // memoize on attempt, not just success — a persistent icacls failure (e.g. no USERNAME) must not retry every call and re-spam the warning
}

function restrictSpoolDirPermissionsUnmemoized(dir: string): void {
  if (platform() !== 'win32') {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort on filesystems without POSIX permission bits */
    }
    return;
  }
  const user = process.env['USERNAME'];
  if (!user) {
    console.warn(`[astramem-local] WARNING: could not restrict ACL on ${dir} — USERNAME env var not set.`);
    return;
  }
  try {
    execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { stdio: 'pipe', timeout: 10_000 });
  } catch (err) {
    console.warn(
      `[astramem-local] WARNING: could not restrict ACL on ${dir} ` +
      `(icacls failed: ${err instanceof Error ? err.message : String(err)}). Spooled envelopes ` +
      `(and quarantined ones, which may still hold unparseable-but-redacted content) may be ` +
      `readable by other local accounts — fix manually: icacls "${dir}" /inheritance:r /grant:r ${user}:(OI)(CI)F`,
    );
  }
}

/**
 * Redact every known free-text field of a spool envelope, reusing the exact
 * `redactIfEnabled` choke point the daemon's own stage-0 ingest uses
 * (src/server/routes/ingest.ts) — same config, same detectors, same
 * placeholder format, so a value redacted here and a value redacted at
 * ingest are indistinguishable. Structural, not content-aware: walks the
 * three free-text shapes `CanonicalIngestSchema` (and the legacy envelope)
 * define — `turns[].text`, `events[].text` / `events[].evidence`, and
 * `content` — and leaves every other field (including a shape this function
 * doesn't recognize) untouched. Pure; never mutates `body`. A non-object
 * `body` (or one with none of these fields) round-trips unchanged.
 */
export function redactSpoolEnvelope(body: unknown, config: Config): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const rec = body as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rec };

  if (Array.isArray(rec['turns'])) {
    out['turns'] = (rec['turns'] as unknown[]).map(t => {
      if (!t || typeof t !== 'object') return t;
      const turn = t as Record<string, unknown>;
      if (typeof turn['text'] !== 'string') return turn;
      return { ...turn, text: redactIfEnabled(turn['text'], config).text };
    });
  }

  if (Array.isArray(rec['events'])) {
    out['events'] = (rec['events'] as unknown[]).map(e => {
      if (!e || typeof e !== 'object') return e;
      const ev = e as Record<string, unknown>;
      const next: Record<string, unknown> = { ...ev };
      if (typeof ev['text'] === 'string') next['text'] = redactIfEnabled(ev['text'], config).text;
      if (typeof ev['evidence'] === 'string') next['evidence'] = redactIfEnabled(ev['evidence'], config).text;
      return next;
    });
  }

  if (typeof rec['content'] === 'string') {
    out['content'] = redactIfEnabled(rec['content'], config).text;
  }

  return out;
}

/**
 * Recursively redact every STRING VALUE in `value` — any field, any depth,
 * through arrays and plain objects — leaving object KEYS and non-string
 * primitives (numbers, booleans, null) untouched. Pure; never mutates
 * `value`.
 *
 * Review fix (2026-07-13): the first cut of `sweepQuarantineRedaction`
 * tried to be shape-agnostic by running `redactIfEnabled` over the fully
 * SERIALIZED text of a parseable envelope (structural pass + second raw-
 * text pass). That is unsafe for JSON: `redactIfEnabled`'s entropy detector
 * tokenizes on whitespace, and a JSON value with no internal whitespace —
 * e.g. `"session_id": "proxy-<uuid>",` — tokenizes as `"proxy-<uuid>",`
 * INCLUDING the surrounding quotes and trailing comma, since nothing
 * whitespace-separates them from the value. A high-entropy match on that
 * token gets replaced WHOLESALE — quotes and comma included — with a bare,
 * unquoted `[REDACTED:...]` placeholder, corrupting the JSON. Confirmed
 * reproducible on every real proxy envelope (`session_id: proxy-${randomUUID()}`,
 * src/capture/proxy.ts `buildProxyEnvelope`) — not an edge case, the common
 * case. Worse, the sweep still reported `redacted: 1` (success) while having
 * destroyed the file's structure.
 *
 * This function is the fix: it operates on the DECODED value tree, never on
 * serialized text, so it structurally CANNOT touch a JSON delimiter —
 * `redactIfEnabled` only ever receives one already-isolated string at a
 * time, with no surrounding quote/comma/brace characters attached, and
 * `JSON.stringify` re-quotes/re-escapes the result correctly afterward. It
 * fully supersedes `redactSpoolEnvelope`'s four-field allowlist (it walks
 * every field, not just `turns[].text` / `events[].text`/`evidence` /
 * `content`) using the exact same `redactIfEnabled` primitive underneath —
 * not a second redaction implementation, the same one applied at the
 * correct granularity (values, not serialized bytes).
 *
 * Over-redaction note (quarantine only): the entropy detector has pre-existing
 * false positives on legitimate high-entropy identifiers — a bare
 * `proxy-<uuid>` session_id, scanned in isolation, often scores above the
 * threshold and becomes a placeholder. That is tolerable HERE and only here,
 * because quarantined files are dead: nothing reads them but this sweep. It
 * would NOT be tolerable on the live write path, where `session_id` is a
 * required identifier the drain uses for the session upsert — a placeholder
 * still satisfies `z.string().min(1)`, so the schema would pass and session
 * identity would be destroyed silently. `writeToSpool` therefore does NOT
 * call this function.
 *
 * Depth: capped at MAX_WALK_DEPTH. Recursion is bounded by a number we chose,
 * not by whatever the stack happens to allow — a RangeError's threshold varies
 * with the runtime and with how deep the caller already is, and (crucially)
 * vitest's worker stack is deeper than the daemon's, so an uncapped walk is
 * untestable by construction. Exceeding the cap throws WalkTooDeepError, which
 * the caller must NOT confuse with "this file isn't JSON".
 */
export class WalkTooDeepError extends Error {
  constructor(depth: number) {
    super(`redactValuesDeep: nesting exceeded MAX_WALK_DEPTH (${depth}) — refusing to walk`);
    this.name = 'WalkTooDeepError';
  }
}

/** Bounded well below the ~1.8k depth at which a plain `node` process (how the
 *  daemon actually runs) overflows its stack in this walk. Real envelopes nest
 *  a handful of levels; anything past this is malformed or hostile. */
export const MAX_WALK_DEPTH = 200;

export function redactValuesDeep(value: unknown, config: Config, depth = 0): unknown {
  if (depth > MAX_WALK_DEPTH) throw new WalkTooDeepError(MAX_WALK_DEPTH);
  if (typeof value === 'string') return redactIfEnabled(value, config).text;
  if (Array.isArray(value)) return value.map(v => redactValuesDeep(v, config, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValuesDeep(v, config, depth + 1); // key itself untouched — structure, not content
    }
    return out;
  }
  return value; // numbers, booleans, null pass through untouched
}

/**
 * Write `body` (a JSON-serializable envelope) to the spool keyed by
 * `idempotencyKey`, via tmp-file + atomic rename — a reader can never
 * observe a torn/partial file. Re-writing the same key is a same-path
 * overwrite, not a duplicate (AC-2). Returns the final spool file path.
 *
 * `config` (default `defaultConfig()`, which ships `security.redaction.
 * enabled: true`) drives `redactSpoolEnvelope` — applied BEFORE the bytes
 * are serialized, so redaction covers every path out of this function,
 * including one that later fails schema validation and gets quarantined
 * (see module doc). Real callers (src/cli/capture.ts, src/capture/proxy.ts)
 * pass the operator's actual resolved config so a custom entropy threshold,
 * custom patterns, or an explicit opt-out are honored identically to the
 * daemon's own ingest-time redaction; the default exists so a caller that
 * forgets to pass one fails safe (redaction ON) rather than silently open.
 */
export function writeToSpool(dataDir: string, idempotencyKey: string, body: unknown, config: Config = defaultConfig()): string {
  // Defense-in-depth: the key becomes a filename segment. Every caller passes
  // a SHA-256 hex digest; reject anything else so no future caller can
  // path-traverse (`../`) or escape the spool dir via a crafted key.
  if (!/^[0-9a-f]{64}$/.test(idempotencyKey)) {
    throw new Error(`writeToSpool: idempotencyKey must be a 64-char lowercase hex digest, got ${JSON.stringify(idempotencyKey).slice(0, 80)}`);
  }
  const dir = spoolDir(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Unconditional (not gated on "just created") — Finding 1: a directory
  // that already existed before this hardening shipped never got an ACL/
  // chmod pass otherwise. Memoized per-process, so this is cheap after the
  // first call — see ensureSpoolDirPermissions doc.
  ensureSpoolDirPermissions(dir);
  const finalPath = join(dir, `${idempotencyKey}.json`);
  const tmpPath = join(dir, `.${idempotencyKey}.${process.pid}.${Date.now()}.tmp`);
  const redacted = redactSpoolEnvelope(body, config);
  writeFileSync(tmpPath, JSON.stringify(redacted, null, 2), { mode: 0o600 });
  renameSync(tmpPath, finalPath);
  bumpSpoolStat(dataDir, 'totalSpooled');
  return finalPath;
}

export interface SpoolFile {
  path: string;
  /** The idempotency key — the filename stem (without `.json`). */
  key: string;
  size: number;
}

/** List drainable spool files — excludes the `.quarantine/` subdir and any
 *  in-flight tmp file (dotfile-prefixed, per writeToSpool above). */
export function listSpoolFiles(dataDir: string): SpoolFile[] {
  const dir = spoolDir(dataDir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // spool dir doesn't exist yet — nothing captured, not an error
  }
  const out: SpoolFile[] = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.') || !e.name.endsWith('.json')) continue;
    const path = join(dir, e.name);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue; // vanished between readdir and stat (raced another drain) — skip
    }
    out.push({ path, key: e.name.slice(0, -'.json'.length), size });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Move a poison/oversize spool file into `ingest-spool/.quarantine/` (AC-5),
 * writing a sibling `<key>.reason.txt` so the reason is auditable on disk.
 * Best-effort: if the source already vanished (raced another drain tick),
 * this is a no-op rather than a throw.
 */
export function quarantineSpoolFile(dataDir: string, file: SpoolFile, reason: string): void {
  const qDir = spoolQuarantineDir(dataDir);
  if (!existsSync(qDir)) mkdirSync(qDir, { recursive: true });
  // Unconditional, same reasoning as writeToSpool above (Finding 1) — self-
  // heals an install whose `.quarantine/` predates this hardening, not just
  // one whose parent lacks inherited ACLs.
  ensureSpoolDirPermissions(qDir);
  const dest = join(qDir, `${file.key}.json`);
  try {
    renameSync(file.path, dest);
  } catch {
    return;
  }
  try {
    writeFileSync(join(qDir, `${file.key}.reason.txt`), `${reason}\n`);
  } catch {
    /* best-effort — the quarantined envelope itself is the important part */
  }
  bumpSpoolStat(dataDir, 'totalQuarantined');
}

/** Delete a successfully-drained spool file. Best-effort — already-gone is fine. */
export function deleteSpoolFile(file: SpoolFile): void {
  try {
    unlinkSync(file.path);
  } catch {
    /* already gone — fine */
  }
}

/**
 * 7 days — matches the existing `ingestIdempotency.retentionDays: 7` default
 * (src/config/config.ts) already used elsewhere in this same ingest
 * subsystem, rather than the longer 30-day `purge.restoreWindowDays` used
 * for reversible user-facing deletions. Deliberately shorter: quarantine is
 * a heightened-risk location by construction (module doc — the selection
 * effect means it disproportionately holds secrets), and the doctor canary
 * below (checkSpoolQuarantine, src/doctor/checks.ts) surfaces its age every
 * run, so an operator has ample warning before a file ever ages out.
 */
export const DEFAULT_QUARANTINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface QuarantinePruneResult {
  removed: number;
  remaining: number;
}

/**
 * Delete quarantine files (and their `.reason.txt` sidecar) older than
 * `maxAgeMs`. Called once per spool-drain tick (src/ingest/spool-drain.ts) —
 * cheap (a readdir + one stat per quarantined key; real installs quarantine
 * rarely) so running it every tick rather than on a separate timer is fine.
 * Content is already redacted at spool-write time (see module doc), so this
 * is purely a retention/hygiene sweep, not a second redaction pass.
 */
export function pruneExpiredQuarantine(dataDir: string, maxAgeMs: number = DEFAULT_QUARANTINE_TTL_MS): QuarantinePruneResult {
  const qDir = spoolQuarantineDir(dataDir);
  let entries: string[];
  try {
    entries = readdirSync(qDir);
  } catch {
    return { removed: 0, remaining: 0 }; // no quarantine dir yet — nothing to prune
  }

  const keys = new Set(entries.filter(n => n.endsWith('.json')).map(n => n.slice(0, -'.json'.length)));
  const now = Date.now();
  let removed = 0;
  for (const key of keys) {
    const jsonPath = join(qDir, `${key}.json`);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(jsonPath).mtimeMs;
    } catch {
      continue; // vanished between readdir and stat (raced a concurrent sweep) — skip
    }
    if (now - mtimeMs <= maxAgeMs) continue;
    try {
      unlinkSync(jsonPath);
    } catch {
      continue; // couldn't remove — leave the sidecar too, retry next tick
    }
    try {
      unlinkSync(join(qDir, `${key}.reason.txt`));
    } catch {
      /* sidecar may not exist or already be gone — best-effort */
    }
    removed++;
  }

  let remaining = 0;
  try {
    remaining = readdirSync(qDir).filter(n => n.endsWith('.json')).length;
  } catch {
    /* dir vanished mid-sweep — remaining stays 0 */
  }
  return { removed, remaining };
}

export interface QuarantineRedactionSweepResult {
  /** `.json` files inspected. */
  scanned: number;
  /** Files whose on-disk content changed (a redaction was applied and
   *  written back). */
  redacted: number;
  /** Subset of `redacted` that could not be JSON-parsed and were redacted
   *  via the raw-text path instead of the structural per-field walk. */
  unparseable: number;
  /** Files that could not be read or safely rewritten — left untouched,
   *  original content intact (never deleted on a write failure). */
  failed: number;
  /** Valid JSON that exceeded MAX_WALK_DEPTH and so could not be walked.
   *
   *  These are LEFT UNTOUCHED — deliberately NOT handed to the raw-text path.
   *  Distinct from `unparseable`: that means "not JSON"; this means "JSON we
   *  could not safely process". Collapsing the two is exactly the bug this
   *  counter exists to make visible — see sweepQuarantineRedaction. */
  unwalkable: number;
}

/**
 * Finding 2 (2026-07-13 fast-follow): #225 redacts everything written to
 * the spool from that point forward, but content already sitting in
 * `.quarantine/` from BEFORE #225 was never touched — it keeps its original
 * unredacted bytes until `pruneExpiredQuarantine` ages it out at the 7-day
 * TTL, and that prune only runs if a spool-drain tick actually fires. This
 * is precisely the module doc's "most likely place on disk for a live
 * credential to sit indefinitely" — the one thing #225 left untouched.
 *
 * Called once per daemon boot (src/cli/serve.ts, alongside the existing
 * spool-drain boot pass) — NOT per drain tick, since re-scanning the same
 * already-redacted quarantine directory 2880 times a day (30s cadence) buys
 * nothing once every file in it has already been rewritten once.
 *
 * Idempotent by construction, so a repeat run (e.g. a second boot before
 * anything new was quarantined) is safe: `redactIfEnabled` skips spans
 * already occupied by a `[REDACTED:...]` placeholder (src/redact/index.ts
 * `protectedRanges`), so re-redacting already-redacted content is a no-op
 * and produces byte-identical output — which this function detects and
 * skips the write for.
 *
 * Two branches, deliberately using OPPOSITE redaction strategies — do not
 * "simplify" them into one:
 *
 * - **Parseable** (the common case — see review-fix history below): walk
 *   the DECODED value tree with `redactValuesDeep`, never the serialized
 *   text. This is JSON-safe by construction (see that function's doc for
 *   why a text-blob scan corrupts JSON) and fully shape-agnostic (every
 *   field, any depth — no allowlist to miss a reshaped/debug-augmented
 *   envelope).
 * - **Unparseable** (can't JSON.parse -> there is no value tree to walk):
 *   apply `redactIfEnabled` directly to the RAW file text instead. This is
 *   the right tool here for the OPPOSITE reason it's wrong above: the file
 *   is already structurally broken, so there are no delimiters left to
 *   protect — corrupting further JSON structure that doesn't exist costs
 *   nothing, while leaving a live credential in an unparseable file costs a
 *   great deal. Chosen over deletion because (a) it reuses the exact same
 *   redactor, not a second implementation; (b) deletion destroys forensic
 *   value (the `.reason.txt` sidecar records WHY the file failed to parse —
 *   losing the file loses the ability to ever diagnose what broke, or
 *   recover it if it turns out to be a false positive rather than a
 *   secret); (c) the module's own selection-effect argument is that
 *   unparseable content disproportionately correlates with secrets — the
 *   population a whole-text regex/entropy pass is best suited to, not
 *   worst.
 *
 * Review-fix history (2026-07-13, two rounds): round 1 replaced a four-field
 * ALLOWLIST (`redactSpoolEnvelope` alone) with that same allowlist plus a
 * second raw-text `redactIfEnabled` pass over the fully SERIALIZED envelope
 * — reasoning it was "the same shape-agnostic tool the unparseable branch
 * already uses." That broke on real input: the entropy detector tokenizes
 * on whitespace, and a JSON value with no internal whitespace — e.g.
 * `"session_id": "proxy-<uuid>",` (every real proxy envelope has one, see
 * `redactValuesDeep`'s doc) — tokenizes INCLUDING its surrounding quotes and
 * comma, and a high-entropy match replaced the whole token, corrupting the
 * JSON while the sweep still reported `redacted: 1` (success). Round 2 (this
 * version) fixed it by never running the shape-agnostic pass over serialized
 * text for valid JSON — only over isolated, already-decoded string values.
 *
 * Never loses a file on a write failure: writes via the same tmp-file +
 * atomic rename pattern `writeToSpool` uses, so a crash or an I/O error
 * mid-write leaves the ORIGINAL file in place (the tmp file is discarded,
 * not the source) rather than a torn or missing quarantine entry.
 */
export function sweepQuarantineRedaction(dataDir: string, config: Config = defaultConfig()): QuarantineRedactionSweepResult {
  const qDir = spoolQuarantineDir(dataDir);
  let entries: string[];
  try {
    entries = readdirSync(qDir);
  } catch {
    return { scanned: 0, redacted: 0, unparseable: 0, failed: 0, unwalkable: 0 }; // no quarantine dir yet
  }

  let scanned = 0;
  let redacted = 0;
  let unparseable = 0;
  let failed = 0;
  let unwalkable = 0;

  for (const name of entries.filter(n => n.endsWith('.json'))) {
    scanned++;
    const filePath = join(qDir, name);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      failed++; // vanished mid-sweep, or unreadable — leave it, retry next boot
      continue;
    }

    // THREE outcomes, not two. Parsing and walking are separate failures and
    // they need separate recoveries — folding them into one catch is how a
    // valid-JSON file whose walk overflowed got handed to the raw-text path
    // and corrupted. The raw-text path is safe ONLY because an unparseable
    // file has no delimiters left to protect; that premise is false for a
    // file that parsed fine and merely nested too deep.
    let envelope: unknown;
    let wasUnparseable = false;
    try {
      envelope = JSON.parse(raw);
    } catch {
      wasUnparseable = true;
    }

    let rewritten: string;
    if (wasUnparseable) {
      // Genuinely not JSON. Raw-text redaction is correct here precisely
      // because the input isn't JSON — the same reason it is WRONG below.
      rewritten = redactIfEnabled(raw, config).text;
    } else {
      try {
        rewritten = JSON.stringify(redactValuesDeep(envelope, config), null, 2);
      } catch (err) {
        if (err instanceof WalkTooDeepError) {
          // Valid JSON we could not safely process. Leave it EXACTLY as it is.
          // Do not fall back to raw-text: that would corrupt a well-formed
          // file. Do not count it as redacted: it wasn't. Surface it instead.
          unwalkable++;
          continue;
        }
        throw err; // unexpected — do not silently swallow
      }
    }

    // Counts as redacted if the walk/scan changed anything relative to the
    // original bytes — a file the sweep examined but couldn't improve must
    // not be indistinguishable from a file it never looked at.
    if (rewritten === raw) continue; // already redacted (or genuinely nothing to redact) — no write needed

    const tmpPath = join(qDir, `.${name}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(tmpPath, rewritten, { mode: 0o600 });
      renameSync(tmpPath, filePath);
      redacted++;
      if (wasUnparseable) unparseable++;
    } catch {
      failed++;
      try {
        unlinkSync(tmpPath);
      } catch {
        /* tmp file may not have been created, or already gone — best-effort cleanup */
      }
    }
  }

  return { scanned, redacted, unparseable, failed, unwalkable };
}
