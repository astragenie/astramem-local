/**
 * Structured pino logger for AstraMemory Local.
 *
 * - Default level: info. Override with LOG_LEVEL env.
 * - JSON emit (service mode). pino-pretty auto-activated when LOG_PRETTY=1 and
 *   pino-pretty is installed (optional dev dep).
 * - Secret scrubber applied via pino's built-in redact OR serializer fallback.
 *
 * Usage:
 *   import { logger, childLogger } from '../log/logger.js';
 *
 *   // root logger — use in top-level server code
 *   logger.info({ event: 'server.start', port: 7777 }, 'daemon started');
 *
 *   // child logger — bind fields for a request / job / stage
 *   const log = childLogger({ request_id, session_id });
 *   log.info({ status: 200, duration_ms: 12 }, 'request complete');
 */

import pino from 'pino';
import { statSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isSensitiveKey } from './scrub.js';

/**
 * ISO-8601 UTC timestamp for RAW console.* lines emitted during daemon
 * runtime (server, pipeline handlers, job worker, sync shipper/puller).
 * pino `logger.*` calls already carry a `time` field — this helper is only
 * for the raw console.log/warn/error lines that bypass pino. Shared so every
 * runtime call site stamps identically instead of re-declaring a local dup.
 */
export const ts = (): string => new Date().toISOString();

const level = process.env['LOG_LEVEL'] ?? 'info';

/**
 * Pino redactPaths — catches known sensitive field names at top-level and
 * nested under 'req', 'res', 'headers', 'body'. Supplements scrubObj for
 * log-line objects we control.
 */
const redactPaths: string[] = [
  'authorization',
  'api_key',
  'apiKey',
  'token',
  'bearer',
  'password',
  'secret',
  'MEMORY_BEARER',
  'azure_api_key',
  // Nested in HTTP context objects
  'req.headers.authorization',
  'headers.authorization',
  'headers.api-key',
  'headers["api-key"]',
];

/**
 * Custom serializer for Error objects: captures message + kind, no stack-with-payload.
 * Stack is emitted only at debug level by the caller if needed.
 */
function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      error_message: err.message,
      error_kind: err.name ?? 'Error',
    };
  }
  return { error_message: String(err), error_kind: 'Unknown' };
}

let transport: pino.TransportSingleOptions | undefined;

/** Rotation policy for the in-process service-mode log stream (see below). */
const LOG_ROTATE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_ROTATE_KEEP = 5;
const LOG_ROTATE_CHECK_MS = 60_000;
/** Live file the daemon writes; rotated copies are `daemon.live.<epochMs>.log`.
 *  Both shapes match the dashboard logs page's `daemon.*.log` discovery (it
 *  picks newest-by-mtime, which is always the live file). */
const LIVE_LOG_BASENAME = 'daemon.live.log';

/**
 * Service-mode log stream: an IN-PROCESS async SonicBoom destination plus a
 * tiny self-rotation sweep — deliberately NOT pino.transport('pino-roll').
 *
 * pino-roll runs in a worker thread connected via thread-stream, whose write
 * path blocks the MAIN thread in Atomics.wait once the shared ring buffer
 * fills faster than the worker drains. On this box the worker demonstrably
 * stalls: a prior `_flushSync took too long (10s)` FATAL, and a live-captured
 * 2026-07-15 incident — event loop frozen 23+ minutes, 0 CPU, inspector
 * unattachable (blocked in native code, not JS), onset always right after a
 * log burst ~80s post-boot. A memory daemon's liveness must never depend on a
 * log-transport worker draining. SonicBoom with `sync: false` buffers
 * in-process and flushes on the event loop: a stalled disk grows the buffer,
 * it never blocks the loop.
 *
 * Rotation (pino-roll's job, now ours): every LOG_ROTATE_CHECK_MS, if the live
 * file exceeds LOG_ROTATE_MAX_BYTES, rename it aside with an epoch stamp,
 * `reopen()` the destination (SonicBoom re-creates the live file), and prune
 * rotated copies beyond LOG_ROTATE_KEEP. Every step is best-effort: on
 * Windows the rename fails with EPERM/EBUSY while another process holds the
 * file open (a `tail -f`, the dashboard reader) — we keep writing to the
 * unrotated file and retry next sweep. Rotation failure must never take the
 * daemon down or block a write.
 *
 * Exported for tests.
 */
export interface ServiceLogStreamOpts {
  /** Test seams — production callers use the defaults. */
  maxBytes?: number;
  keep?: number;
  checkMs?: number;
}

export function createServiceLogStream(
  dir: string,
  opts: ServiceLogStreamOpts = {},
): pino.DestinationStream & { flushSync: () => void; reopen: () => void } {
  const maxBytes = opts.maxBytes ?? LOG_ROTATE_MAX_BYTES;
  const keep = opts.keep ?? LOG_ROTATE_KEEP;
  const checkMs = opts.checkMs ?? LOG_ROTATE_CHECK_MS;
  const livePath = join(dir, LIVE_LOG_BASENAME);
  const dest = pino.destination({ dest: livePath, sync: false, mkdir: true });

  const rotate = (): void => {
    try {
      if (statSync(livePath).size < maxBytes) return;
      renameSync(livePath, join(dir, `daemon.live.${Date.now()}.log`));
      dest.reopen();
      // Prune old rotated copies (never the live file), oldest first.
      const rotated = readdirSync(dir)
        .filter(n => /^daemon\.live\.\d+\.log$/.test(n))
        .sort();
      for (const stale of rotated.slice(0, Math.max(0, rotated.length - keep))) {
        try { unlinkSync(join(dir, stale)); } catch { /* best-effort */ }
      }
    } catch {
      // Missing file / rename blocked by a concurrent reader / transient FS
      // error — retry on the next sweep. Never throw from a log-housekeeping
      // timer.
    }
  };
  setInterval(rotate, checkMs).unref();

  return dest;
}

// Service mode (ASTRA_LOG_DIR set by the shim launcher): JSON logs to
// <ASTRA_LOG_DIR>/daemon.live.log via the in-process stream above, 10MB per
// file, 5 rotated files retained. Without this, a scheduler-supervised
// daemon's stdout either vanishes or grows unbounded under redirection.
// Foreground runs keep stdout.
const logDir = process.env['ASTRA_LOG_DIR'];
let serviceStream: pino.DestinationStream | undefined;
if (logDir) {
  serviceStream = createServiceLogStream(logDir.replace(/[\\/]+$/, ''));
} else if (process.env['LOG_PRETTY'] === '1') {
  // pino-pretty transport: activated via LOG_PRETTY=1 (foreground dev mode).
  try {
    transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  } catch {
    // pino-pretty not installed — fall back to JSON
  }
}

const pinoOpts: pino.LoggerOptions = {
  level,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  serializers: {
    err: serializeError,
    error: serializeError,
  },
};

/**
 * Root logger instance. Long-lived singleton shared across the process.
 * Service mode uses the in-process SonicBoom stream (never a worker-thread
 * transport — see createServiceLogStream); LOG_PRETTY keeps the pino-pretty
 * transport (dev-only foreground, not a daemon-stability surface).
 */
export const logger: pino.Logger = serviceStream
  ? pino(pinoOpts, serviceStream)
  : transport
    ? pino(pinoOpts, pino.transport(transport))
    : pino(pinoOpts);

/**
 * Create a child logger with bound fields.
 * All subsequent log calls on the child will include those fields.
 *
 * Common patterns:
 *   childLogger({ request_id, method, path })          // HTTP layer
 *   childLogger({ request_id, session_id, transcript_id })  // ingest route
 *   childLogger({ job_id, job_kind, attempt })          // worker
 *   childLogger({ job_id, stage })                      // distill stage
 *   childLogger({ provider, model })                    // LLM/embed provider
 *
 * Sensitive fields in bindings are filtered by isSensitiveKey.
 */
export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  // Strip any accidentally-passed sensitive keys from bound fields
  const safe: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(bindings)) {
    if (!isSensitiveKey(key)) {
      safe[key] = val;
    }
  }
  return logger.child(safe);
}

export type { pino };
