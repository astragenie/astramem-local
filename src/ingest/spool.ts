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
}

/** Best-effort read — a missing/corrupt stats file (e.g. a fresh install, or
 *  a torn write from a killed process — this file is NOT written via the
 *  tmp+rename atomic pattern, since it's observability, not durable content)
 *  reads back as zeros rather than throwing. */
export function readSpoolStats(dataDir: string): SpoolStats {
  try {
    const parsed = JSON.parse(readFileSync(spoolStatsPath(dataDir), 'utf8')) as Partial<SpoolStats>;
    return {
      totalSpooled: typeof parsed.totalSpooled === 'number' ? parsed.totalSpooled : 0,
      totalQuarantined: typeof parsed.totalQuarantined === 'number' ? parsed.totalQuarantined : 0,
    };
  } catch {
    return { totalSpooled: 0, totalQuarantined: 0 };
  }
}

/** Best-effort increment — a stats-file write failure must never break the
 *  spool write/quarantine path it's merely observing. Not safe against
 *  concurrent-writer races (a lost increment under true concurrency is
 *  acceptable for an observability counter; it is never read as an exact
 *  audit trail, only as ADR-015's "state the denominator" doctor signal). */
function bumpSpoolStat(dataDir: string, field: keyof SpoolStats): void {
  try {
    const dir = spoolDir(dataDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stats = readSpoolStats(dataDir);
    stats[field] += 1;
    writeFileSync(spoolStatsPath(dataDir), JSON.stringify(stats), { mode: 0o600 });
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
function restrictSpoolDirPermissions(dir: string): void {
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
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    restrictSpoolDirPermissions(dir); // once at creation — Windows ACL inheritance covers every future file
  }
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
  if (!existsSync(qDir)) {
    mkdirSync(qDir, { recursive: true });
    // Explicit even though `.quarantine/` sits under the already-hardened
    // spool dir and Windows ACL inheritance ((OI)(CI) on the parent) should
    // already cover it — self-heals an install whose spool dir predates this
    // slice (created before restrictSpoolDirPermissions existed) and whose
    // parent therefore carries no restricted ACL to inherit from.
    restrictSpoolDirPermissions(qDir);
  }
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
