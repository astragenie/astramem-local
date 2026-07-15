/**
 * GET /dashboard/logs — recent daemon log lines, readable in the browser.
 *
 * Mirrors dashboard-jobs-html.ts's structure (route factory + shared
 * checkDashboardAuth). Zero JS, per the dashboard convention (app.ts:80) —
 * auto-refresh via <meta http-equiv="refresh">, not polling.
 *
 * Log source resolution (CLAUDE.md "MCP transport" / service-mode notes):
 *   - Service mode: ASTRA_LOG_DIR set, pino-roll writes JSON lines to
 *     `<logsDir>/daemon.<N>.log` (numbered rotation — pino-roll v4 always
 *     appends a rotation number, see node_modules/pino-roll/README.md; there
 *     is never a bare `daemon.log` on disk). We pick the NEWEST such file by
 *     mtime.
 *   - Foreground / no ASTRA_LOG_DIR: nothing rotated lands here, but the
 *     shim's launcher (service/shim.ts) still captures raw stdout to
 *     `<logsDir>/daemon-stdout.log` when running under the service shim. We
 *     fall back to that file when no `daemon.*.log` exists.
 *   - Neither present (e.g. `serve` run directly, no service, no log dir
 *     yet): empty state, never throws.
 *
 * Only the last ~64KB of the chosen file is read (readTail pattern from
 * service/shim.ts) — the file can be up to 10MB (pino-roll's rotation size),
 * and this route must never load a whole rotated log into memory.
 */

import type { FastifyInstance } from 'fastify';
import { openSync, closeSync, fstatSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkDashboardAuth } from './dashboard-auth.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Read only the last `maxBytes` of a file. Never throws — returns '' for a
 *  missing/unreadable file, mirroring service/shim.ts's readTail(). */
function readTail(filePath: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return '';
    const readSize = Math.min(size, maxBytes);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, size - readSize);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    try { closeSync(fd); } catch { /* best-effort */ }
  }
}

const TAIL_BYTES = 64 * 1024;
const MAX_LINES = 200;

/** Picks the newest `daemon.*.log` (pino-roll rotation) in logsDir, falling
 *  back to `daemon-stdout.log` (shim-captured stdout), else null. Never
 *  throws — a missing/unreadable logsDir just yields null. */
function resolveLogFile(logsDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch {
    entries = [];
  }
  const rotated = entries.filter(name => /^daemon\.[^/\\]*\.log$/.test(name));
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of rotated) {
    const path = join(logsDir, name);
    try {
      const mtimeMs = statSync(path).mtimeMs;
      if (newest === null || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
    } catch {
      // skip unreadable entry
    }
  }
  if (newest !== null) return newest.path;

  const stdoutPath = join(logsDir, 'daemon-stdout.log');
  try {
    statSync(stdoutPath);
    return stdoutPath;
  } catch {
    return null;
  }
}

interface ParsedLine {
  raw: string;
  level: number | null;
  time: number | null;
  msg: string | null;
  context: string | null;
}

/** Pulls a short "what was this" context string out of pino's free-form
 *  extra fields — method+path+status for HTTP request logs, job_kind for
 *  job logs, provider+latency for provider calls. Best-effort; absent
 *  fields just fall through. */
function extractContext(obj: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if (typeof obj['method'] === 'string' && typeof obj['path'] === 'string') {
    parts.push(`${obj['method']} ${obj['path']}`);
    if (typeof obj['status'] === 'number') parts.push(String(obj['status']));
  } else if (typeof obj['job_kind'] === 'string') {
    parts.push(String(obj['job_kind']));
  } else if (typeof obj['provider'] === 'string') {
    parts.push(String(obj['provider']));
    if (typeof obj['latency_ms'] === 'number') parts.push(`${obj['latency_ms']}ms`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function parseLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (trimmed === '') return { raw: line, level: null, time: null, msg: null, context: null };
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const level = typeof obj['level'] === 'number' ? obj['level'] : null;
    const time = typeof obj['time'] === 'number' ? obj['time'] : null;
    const msg = typeof obj['msg'] === 'string' ? obj['msg'] : null;
    return { raw: line, level, time, msg, context: extractContext(obj) };
  } catch {
    return { raw: line, level: null, time: null, msg: null, context: null };
  }
}

function fmtTime(epochMs: number | null): string {
  if (epochMs === null) return '—';
  try {
    return new Date(epochMs).toLocaleTimeString(undefined, { hour12: false });
  } catch {
    return '—';
  }
}

function levelLabel(level: number | null): { text: string; cls: string } {
  if (level === null) return { text: '—', cls: 'muted' };
  if (level >= 50) return { text: 'ERROR', cls: 'err' };
  if (level >= 40) return { text: 'WARN', cls: 'warn' };
  if (level >= 30) return { text: 'INFO', cls: '' };
  return { text: 'DEBUG', cls: 'muted' };
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a1a;color:#e0e0e0;font-family:monospace;font-size:13px;line-height:1.5;padding:16px}
h1{font-size:18px;color:#fff;margin-bottom:4px}
h2{font-size:14px;color:#aaa;margin:20px 0 8px;border-bottom:1px solid #333;padding-bottom:4px;text-transform:uppercase;letter-spacing:.05em}
section{margin-bottom:24px}
.meta{color:#888;font-size:12px;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#222;color:#aaa;text-align:left;padding:5px 8px;font-weight:normal;text-transform:uppercase;letter-spacing:.04em}
td{padding:4px 8px;border-bottom:1px solid #252525;font-variant-numeric:tabular-nums;vertical-align:top}
tr:nth-child(odd) td{background:#1e1e1e}
tr.err td{background:#2a1414}
tr.warn td{background:#2a2010}
.msg{white-space:pre-wrap;word-break:break-word}
.badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px}
.err{color:#e74c3c}
.warn{color:#f39c12}
.muted{color:#666}
`.trim();

function renderRows(lines: ParsedLine[]): string {
  return lines.map(line => {
    const { text: levelText, cls: levelCls } = levelLabel(line.level);
    const rowCls = levelCls === 'err' ? ' class="err"' : levelCls === 'warn' ? ' class="warn"' : '';
    const msg = line.msg ?? line.raw;
    return `<tr${rowCls}>
      <td class="muted" style="width:90px">${esc(fmtTime(line.time))}</td>
      <td style="width:70px"><span class="badge ${esc(levelCls)}">${esc(levelText)}</span></td>
      <td style="width:220px">${line.context !== null ? esc(line.context) : '<span class="muted">—</span>'}</td>
      <td class="msg">${esc(msg)}</td>
    </tr>`;
  }).join('');
}

function renderPage(logPath: string | null, lines: ParsedLine[]): string {
  const meta = logPath !== null
    ? `<div class="meta">source: ${esc(logPath)} &middot; showing last ${lines.length} line${lines.length === 1 ? '' : 's'} (tail ${TAIL_BYTES / 1024}KB)</div>`
    : '<div class="meta">no log file found</div>';
  const body = lines.length === 0
    ? '<p class="muted">No log lines available yet.</p>'
    : `<table>
  <thead><tr><th>Time</th><th>Level</th><th>Context</th><th>Message</th></tr></thead>
  <tbody>${renderRows(lines)}</tbody>
</table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>AstraMemory Dashboard — Logs</title>
<style>${CSS}</style>
</head>
<body>
<h1>AstraMemory Local — Logs</h1>
${meta}
<section>
${body}
</section>
</body>
</html>`;
}

export function dashboardLogsRoute(dataDir: string, token: string, devNoAuthActive = false) {
  return async (app: FastifyInstance) => {
    app.get('/dashboard/logs', async (req, reply) => {
      const authResult = checkDashboardAuth(req, token, devNoAuthActive);
      if (!authResult.allowed) {
        return reply
          .code(authResult.status)
          .header('content-type', 'text/plain; charset=utf-8')
          .send(authResult.body);
      }

      const logsDir = join(dataDir, 'logs');
      const logPath = resolveLogFile(logsDir);
      const tail = logPath !== null ? readTail(logPath, TAIL_BYTES) : '';
      const rawLines = tail.length > 0 ? tail.split(/\r?\n/).filter(l => l.trim() !== '') : [];
      const lines = rawLines.slice(-MAX_LINES).map(parseLine);

      return reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(renderPage(logPath, lines));
    });
  };
}
