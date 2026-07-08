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

// Service mode (ASTRA_LOG_DIR set by the shim launcher): rotate JSON logs to
// <ASTRA_LOG_DIR>/daemon.log, 10MB per file, 5 files retained. Without this,
// a scheduler-supervised daemon's stdout either vanishes or grows unbounded
// under redirection. Foreground runs keep stdout.
const logDir = process.env['ASTRA_LOG_DIR'];
if (logDir) {
  transport = {
    target: 'pino-roll',
    options: {
      file: `${logDir.replace(/[\\/]+$/, '')}/daemon.log`,
      size: '10m',
      limit: { count: 5 },
      mkdir: true,
    },
  };
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
 */
export const logger: pino.Logger = transport
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
