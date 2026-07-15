/**
 * GET /dashboard/jobs — kind × state matrix + failed/poison detail
 * (FEAT-410 wave 2, SLICE-410-5).
 *
 * Backed by queryJobStatesByKind + queryRecentFailedJobs (queries/dashboard.ts,
 * SLICE-410-1's contract). The route registration in app.ts and the auth
 * wrapper below are unchanged from the SLICE-410-1 stub.
 *
 * Auth is the shared `checkDashboardAuth` helper (dashboard-auth.ts) — Bearer
 * header, the HttpOnly `astramem_dash` cookie bootstrapped by
 * src/server/routes/dashboard.ts, or (when active) devNoAuth's loopback-only
 * bypass. CSS/esc/age-formatting helpers remain duplicated locally rather
 * than imported from dashboard-html.ts (out of scope here).
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import {
  queryJobStatesByKind,
  queryRecentFailedJobs,
  type JobStateByKind,
  type RecentFailedJob,
} from '../queries/dashboard.js';
import { checkDashboardAuth } from './dashboard-auth.js';
import { renderDashboardNav, DASHBOARD_NAV_CSS } from './dashboard-nav.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Mirrors dashboard-html.ts's mockup format ("2h 4m", "40m", "12s"). */
function fmtAgeMs(msIn: number): string {
  const ms = Math.max(0, msIn);
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a1a;color:#e0e0e0;font-family:monospace;font-size:13px;line-height:1.5;padding:16px}
h1{font-size:18px;color:#fff;margin-bottom:4px}
h2{font-size:14px;color:#aaa;margin:20px 0 8px;border-bottom:1px solid #333;padding-bottom:4px;text-transform:uppercase;letter-spacing:.05em}
${DASHBOARD_NAV_CSS}
section{margin-bottom:24px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#222;color:#aaa;text-align:left;padding:5px 8px;font-weight:normal;text-transform:uppercase;letter-spacing:.04em}
td{padding:4px 8px;border-bottom:1px solid #252525;font-variant-numeric:tabular-nums}
tr:nth-child(odd) td{background:#1e1e1e}
tr:hover td{background:#242424}
.num{text-align:right;font-variant-numeric:tabular-nums}
.err{color:#e74c3c}
.warn{color:#f39c12}
.muted{color:#666}
.err-text{white-space:pre-wrap;word-break:break-word}
`.trim();

const STATE_COLUMNS = ['pending', 'running', 'completed', 'failed', 'poison'] as const;

interface MatrixRow {
  kind: string;
  counts: Record<(typeof STATE_COLUMNS)[number], number>;
}

/** AC-1: kind x state matrix. Only the 5 states in STATE_COLUMNS are shown;
 *  other states (e.g. "paused") are intentionally out of scope for this view. */
function buildMatrix(rows: JobStateByKind[]): MatrixRow[] {
  const byKind = new Map<string, MatrixRow['counts']>();
  for (const row of rows) {
    if (!byKind.has(row.kind)) {
      byKind.set(row.kind, { pending: 0, running: 0, completed: 0, failed: 0, poison: 0 });
    }
    const counts = byKind.get(row.kind)!;
    if ((STATE_COLUMNS as readonly string[]).includes(row.state)) {
      counts[row.state as (typeof STATE_COLUMNS)[number]] = row.count;
    }
  }
  return [...byKind.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, counts]) => ({ kind, counts }));
}

function renderMatrix(rows: JobStateByKind[]): string {
  const matrix = buildMatrix(rows);
  if (matrix.length === 0) {
    return '<p class="muted">No jobs recorded yet.</p>';
  }
  const trs = matrix.map(m => {
    const cells = STATE_COLUMNS.map(state => {
      const n = m.counts[state];
      const cls = (state === 'failed' || state === 'poison') && n > 0 ? ' class="num err"' : ' class="num"';
      return `<td${cls}>${n}</td>`;
    }).join('');
    return `<tr><td>${esc(m.kind)}</td>${cells}</tr>`;
  }).join('');
  return `<table>
  <thead><tr>
    <th>Kind</th><th class="num">Pending</th><th class="num">Running</th>
    <th class="num">Completed (24h)</th><th class="num">Failed</th><th class="num">Poison</th>
  </tr></thead>
  <tbody>${trs}</tbody>
</table>`;
}

/** AC-2: RecentFailedJob (queries/dashboard.ts) does not carry `attempts` —
 *  a small ad-hoc lookup against the jobs table fills it in locally rather
 *  than widening the SLICE-410-1 query contract (out of scope for this slice). */
function queryAttemptsForIds(db: DB, ids: string[]): Map<string, number> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, attempts FROM jobs WHERE id IN (${placeholders})`,
  ).all(...ids) as { id: string; attempts: number }[];
  return new Map(rows.map(r => [r.id, r.attempts]));
}

/** AC-3: explicit empty state. AC-6: age from updated_at only. */
function renderDetail(jobs: RecentFailedJob[], attemptsById: Map<string, number>, now: number): string {
  if (jobs.length === 0) {
    return '<p class="muted">No failed or poison jobs</p>';
  }
  const trs = jobs.map(j => {
    const attempts = attemptsById.get(j.id) ?? '<span class="muted">—</span>';
    const errText = j.last_error !== null ? esc(j.last_error) : '<span class="muted">—</span>';
    const age = fmtAgeMs(now - j.updated_at);
    const stateCls = j.state === 'poison' || j.state === 'failed' ? ' class="err"' : '';
    return `<tr>
      <td>${esc(j.id)}</td>
      <td>${esc(j.kind)}</td>
      <td${stateCls}>${esc(j.state)}</td>
      <td class="num">${attempts}</td>
      <td class="err-text">${errText}</td>
      <td class="muted">${esc(age)}</td>
    </tr>`;
  }).join('');
  return `<table>
  <thead><tr>
    <th>ID</th><th>Kind</th><th>State</th><th class="num">Attempts</th><th>Last error</th><th>Age</th>
  </tr></thead>
  <tbody>${trs}</tbody>
</table>`;
}

function renderPage(jobStatesByKind: JobStateByKind[], failedJobs: RecentFailedJob[], attemptsById: Map<string, number>, now: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AstraMemory Dashboard — Jobs</title>
<style>${CSS}</style>
</head>
<body>
<h1>AstraMemory Local — Jobs</h1>
${renderDashboardNav('jobs')}
<section>
  <h2>Kind &times; state</h2>
  ${renderMatrix(jobStatesByKind)}
</section>
<section>
  <h2>Failed / poison detail</h2>
  ${renderDetail(failedJobs, attemptsById, now)}
</section>
</body>
</html>`;
}

export function dashboardJobsRoute(db: DB, token: string, devNoAuthActive = false) {
  return async (app: FastifyInstance) => {
    app.get('/dashboard/jobs', async (req, reply) => {
      const authResult = checkDashboardAuth(req, token, devNoAuthActive);
      if (!authResult.allowed) {
        return reply
          .code(authResult.status)
          .header('content-type', 'text/plain; charset=utf-8')
          .send(authResult.body);
      }

      const jobStatesByKind = queryJobStatesByKind(db);
      const failedJobs = queryRecentFailedJobs(db);
      const attemptsById = queryAttemptsForIds(db, failedJobs.map(j => j.id));

      return reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(renderPage(jobStatesByKind, failedJobs, attemptsById, Date.now()));
    });
  };
}
