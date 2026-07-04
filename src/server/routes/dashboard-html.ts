/**
 * dashboard-html.ts — server-side HTML renderer for /dashboard.
 *
 * FEAT-410 SLICE-410-4: Mission Control rewrite (design doc §4). Renders
 * against the ACTUAL DashboardData/DashboardHealth shapes exported by
 * queries/dashboard.ts (SLICE-410-1) — not the design-doc mockup's literal
 * field names.
 *
 * Zero runtime dependencies: pure string concatenation.
 * No JS in output. <meta refresh> drives auto-poll.
 * Target: < 20 KB gzipped.
 */

import type { DashboardData, DashboardHealth, JobStateByKind } from '../queries/dashboard.js';
import type { Config } from '../../config/config.js';
import { PKG_VERSION, WIRE_VERSIONS_SUPPORTED, SCHEMA_VERSION } from '../lib/wire-meta.js';

// ---------------------------------------------------------------------------
// Helpers (carried over from the pre-Mission-Control renderer)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(epochMs: number): string {
  try {
    return new Date(epochMs).toISOString().slice(11, 19); // HH:MM:SS
  } catch {
    return '??:??:??';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function fmtAgeMs(ms: number): string {
  if (ms < 0) return '0s';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

function fmtBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)}MB`;
}

function budgetColor(spend: number, cap: number): string {
  if (cap <= 0) return '#888';
  const pct = spend / cap;
  if (pct >= 0.8) return '#e74c3c';
  if (pct >= 0.5) return '#f39c12';
  return '#2ecc71';
}

function fmtRate(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Inline CSS
// ---------------------------------------------------------------------------

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a1a;color:#e0e0e0;font-family:monospace;font-size:13px;line-height:1.5;padding:16px}
h1{font-size:18px;color:#fff;display:inline-block}
.meta{color:#888;font-size:12px}
.meta span{color:#ccc}
nav{display:flex;align-items:center;gap:16px;margin:10px 0 16px;padding-bottom:8px;border-bottom:1px solid #333;font-size:12px}
nav a{color:#888;text-decoration:none}
nav a:hover{color:#3a7bd5}
nav .active{color:#fff;font-weight:bold}
nav .asof{margin-left:auto;color:#666}
section{margin-bottom:20px}
.banner{padding:8px 12px;border-radius:4px;font-size:13px;display:flex;gap:18px;flex-wrap:wrap;align-items:center}
.banner.ok{background:#132a1c;border:1px solid #1f5c34}
.banner.degraded{background:#2a1414;border:1px solid #5c1f1f}
.banner .dot{font-size:16px}
.pipeline-title,.strip h3{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.pipeline{display:flex;justify-content:space-between;gap:4px;padding:10px 4px;background:#1e1e1e;border-radius:4px;overflow-x:auto}
.stage{flex:1;min-width:90px;text-align:center;padding:0 4px}
.stage .name{color:#aaa;font-size:11px;text-transform:uppercase}
.stage .val{font-size:14px;margin-top:4px;font-variant-numeric:tabular-nums}
.arrow{color:#555;align-self:center;padding:0 2px}
.strips{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px}
.strips2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.strip{background:#1e1e1e;border-radius:4px;padding:10px 12px}
.strip .big{font-size:18px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#222;color:#aaa;text-align:left;padding:5px 8px;font-weight:normal;text-transform:uppercase;letter-spacing:.04em}
td{padding:4px 8px;border-bottom:1px solid #252525;font-variant-numeric:tabular-nums}
tr:nth-child(odd) td{background:#1e1e1e}
.badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.trunc{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ok{color:#2ecc71}
.warn{color:#f39c12}
.err{color:#e74c3c}
.muted{color:#666}
`.trim();

// ---------------------------------------------------------------------------
// Status banner
// ---------------------------------------------------------------------------

interface BannerStatus {
  label: 'OK' | 'DEGRADED' | 'UNKNOWN';
  failing: string[];
}

/** AC-1/AC-2: OK only when embed.ok===true AND worker.alive===true; any other
 *  combination (including embed.ok===false or worker.alive===false) is
 *  DEGRADED, naming the failing subsystem(s). Unlike healthState.status()
 *  (which only tracks embed), the banner also treats a dead worker as
 *  degraded per AC-2. `null` health (no HealthState wired) reports UNKNOWN
 *  rather than claiming OK — the page still renders fully either way. */
function bannerStatus(health: DashboardHealth | null): BannerStatus {
  if (health === null) return { label: 'UNKNOWN', failing: [] };
  const failing: string[] = [];
  if (health.embed.ok !== true) failing.push('embed');
  if (!health.worker.alive) failing.push('worker');
  return { label: failing.length > 0 ? 'DEGRADED' : 'OK', failing };
}

function renderBanner(health: DashboardHealth | null): string {
  const { label, failing } = bannerStatus(health);
  const cls = label === 'OK' ? 'ok' : label === 'DEGRADED' ? 'degraded' : '';
  const dotColor = label === 'OK' ? '#2ecc71' : label === 'DEGRADED' ? '#e74c3c' : '#888';

  if (health === null) {
    return `<div class="banner ${cls}">
  <span class="dot" style="color:${dotColor}">●</span>
  <span><strong>DAEMON UNKNOWN</strong></span>
  <span class="muted">no health state wired</span>
</div>`;
  }

  const embedOk = health.embed.ok;
  const embedLabel = embedOk === true
    ? '<span class="ok">embed:ok</span>'
    : embedOk === false
      ? `<span class="err">embed:FAIL${health.embed.lastError ? ` (${esc(truncate(health.embed.lastError, 40))})` : ''}</span>`
      : '<span class="muted">embed:starting</span>';

  const workerLabel = health.worker.alive
    ? `<span class="ok">worker:alive${health.worker.lastTickAgoMs !== null ? ` (${fmtAgeMs(health.worker.lastTickAgoMs)} ago)` : ''}</span>`
    : '<span class="err">worker:DEAD</span>';

  const diskLabel = health.diskFreeBytes !== null
    ? `<span class="muted">disk:${fmtBytes(health.diskFreeBytes)} free</span>`
    : '<span class="muted">disk:n/a</span>';

  const failingNote = failing.length > 0
    ? ` <span class="err">(failing: ${failing.map(esc).join(', ')})</span>`
    : '';

  return `<div class="banner ${cls}">
  <span class="dot" style="color:${dotColor}">●</span>
  <span><strong>DAEMON ${label}</strong>${failingNote}</span>
  ${embedLabel}
  ${workerLabel}
  ${diskLabel}
</div>`;
}

// ---------------------------------------------------------------------------
// Pipeline row
// ---------------------------------------------------------------------------

function stageCounts(byKind: JobStateByKind[], kind: string): { pending: number; running: number } {
  let pending = 0;
  let running = 0;
  for (const row of byKind) {
    if (row.kind !== kind) continue;
    if (row.state === 'pending') pending = row.count;
    if (row.state === 'running') running = row.count;
  }
  return { pending, running };
}

function renderPipeline(data: DashboardData): string {
  const ingested24h = data.hourlyThroughput.reduce((sum, r) => sum + r.count, 0);
  const distill = stageCounts(data.jobStatesByKind, 'distill');
  const consolidate = stageCounts(data.jobStatesByKind, 'consolidate');
  const reembed = stageCounts(data.jobStatesByKind, 'reembed');

  const stages: Array<{ name: string; val: string }> = [
    { name: 'ingest', val: `${ingested24h}<span class="muted"> /24h</span>` },
    { name: 'distill', val: `${distill.pending}p / ${distill.running}r` },
    { name: 'entity-link', val: `${data.entityLinkage.entityCount} ent / ${data.entityLinkage.unlinkedMemoryCount} unlinked` },
    { name: 'embed', val: `${reembed.pending}p / ${reembed.running}r` },
    { name: 'consolidate', val: `${consolidate.pending}p / ${consolidate.running}r` },
    { name: 'index', val: '<span class="ok">ok</span>' },
  ];

  const cells = stages.map((s, i) => {
    const arrow = i > 0 ? '<span class="arrow">&rarr;</span>' : '';
    return `${arrow}<div class="stage"><div class="name">${esc(s.name)}</div><div class="val">${s.val}</div></div>`;
  }).join('');

  return `<div class="pipeline-title">Pipeline</div>
<div class="pipeline">${cells}</div>`;
}

// ---------------------------------------------------------------------------
// Jobs / Consolidation / Providers strip
// ---------------------------------------------------------------------------

function jobStateTotal(states: DashboardData['jobStates'], state: string): number {
  return states.find(s => s.state === state)?.count ?? 0;
}

function renderJobsStrip(data: DashboardData): string {
  const pending = jobStateTotal(data.jobStates, 'pending');
  const running = jobStateTotal(data.jobStates, 'running');
  const failed = jobStateTotal(data.jobStates, 'failed');
  const poison = jobStateTotal(data.jobStates, 'poison');
  const poisonCls = poison > 0 ? 'err' : 'muted';
  return `<div class="strip">
  <h3>Jobs</h3>
  <div>pending <strong>${pending}</strong> &nbsp; running <strong>${running}</strong></div>
  <div>failed <strong>${failed}</strong> &nbsp; poison <strong class="${poisonCls}">${poison}</strong>${poison > 0 ? ' &#9888;' : ''}</div>
  <div class="muted"><a href="/dashboard/jobs" style="color:#3a7bd5">view jobs &rarr;</a></div>
</div>`;
}

function renderConsolidationStrip(data: DashboardData): string {
  const { count, oldest } = data.consolidation;
  const body = count === 0
    ? '<div class="muted">0 pending proposals</div>'
    : `<div>&#9679; <strong>${count}</strong> pending proposal${count === 1 ? '' : 's'}</div>
       <div class="muted">oldest: ${oldest !== null ? fmtAgeMs(Date.now() - oldest) : '—'}</div>`;
  return `<div class="strip">
  <h3>Consolidation</h3>
  ${body}
  <div class="muted"><a href="/dashboard/consolidation" style="color:#3a7bd5">resolve &rarr;</a></div>
</div>`;
}

function renderProvidersStrip(data: DashboardData): string {
  if (data.providers.length === 0) {
    return `<div class="strip">
  <h3>Providers / Storage</h3>
  <div class="muted">no providers registered</div>
</div>`;
  }
  const rows = data.providers.map(p => {
    const ok = p.last_health_ok ? '<span class="ok">OK</span>' : '<span class="err">FAIL</span>';
    const dim = p.dim ?? '—';
    return `<div>${esc(p.provider)}/${esc(p.model)} <span class="muted">${dim}-dim</span> &middot; ${ok}</div>`;
  }).join('');
  return `<div class="strip">
  <h3>Providers / Storage</h3>
  ${rows}
</div>`;
}

// ---------------------------------------------------------------------------
// Budget + usefulness tiles (collapsed per AC-5)
// ---------------------------------------------------------------------------

function renderBudgetTile(data: DashboardData, dailyCap: number): string {
  const todayUsd = data.todaySpend?.usd_total ?? 0;
  const color = budgetColor(todayUsd, dailyCap);
  return `<div class="strip">
  <h3>Budget</h3>
  <div class="big" style="color:${color}">$${todayUsd.toFixed(2)} <span class="muted" style="font-size:12px">/ cap $${dailyCap.toFixed(2)}</span></div>
</div>`;
}

function renderUsefulnessTile(usefulness: DashboardData['usefulness']): string {
  return `<div class="strip">
  <h3>Usefulness (7d)</h3>
  <div class="big">${fmtRate(usefulness.rate)}</div>
  <div class="muted">of ${usefulness.served} served recalls marked used (${usefulness.used})</div>
</div>`;
}

// ---------------------------------------------------------------------------
// Merged recent-activity/errors feed
// ---------------------------------------------------------------------------

type FeedRow = { ts: number; html: string };

/** AC-5: replaces the old full 25-row "recent captures" table with a merged
 *  feed of failures (from recentFailedJobs) and a handful of new memories
 *  (from recentMemories), newest first. Individual consolidation proposals
 *  aren't in this feed — queryDashboard only exposes the aggregate
 *  ConsolidationSummary (count/oldest), which the Consolidation strip above
 *  already surfaces; per-row proposal entries belong to the dedicated
 *  /dashboard/consolidation page. */
function renderActivityFeed(data: DashboardData): string {
  const rows: FeedRow[] = [];

  for (const job of data.recentFailedJobs) {
    const stateCls = job.state === 'poison' ? 'err' : 'warn';
    const err = job.last_error ? esc(truncate(job.last_error, 60)) : '<span class="muted">(no error text)</span>';
    rows.push({
      ts: job.updated_at,
      html: `<tr>
        <td class="muted" style="width:90px">${esc(fmtTime(job.updated_at))}</td>
        <td><span class="badge ${stateCls}">${esc(job.state)}</span></td>
        <td>${esc(job.kind)}</td>
        <td class="trunc">${err}</td>
      </tr>`,
    });
  }

  for (const mem of data.recentMemories.slice(0, 8)) {
    rows.push({
      ts: mem.created_at,
      html: `<tr>
        <td class="muted" style="width:90px">${esc(fmtTime(mem.created_at))}</td>
        <td><span class="badge" style="background:#2a2a2a;color:#aaa">memory</span></td>
        <td>${esc(mem.type)}</td>
        <td class="trunc">${esc(truncate(mem.text, 70))}</td>
      </tr>`,
    });
  }

  if (rows.length === 0) {
    return '<p class="muted">No recent activity.</p>';
  }

  rows.sort((a, b) => b.ts - a.ts);
  const trs = rows.slice(0, 15).map(r => r.html).join('');

  return `<table>
  <thead><tr><th>Time</th><th>Kind</th><th>Detail</th><th>Info</th></tr></thead>
  <tbody>${trs}</tbody>
</table>`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function renderDashboard(data: DashboardData, config: Config): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const dailyCap = config.budget.daily_usd;
  const { label } = bannerStatus(data.health);
  const statusColor = label === 'OK' ? '#2ecc71' : label === 'DEGRADED' ? '#e74c3c' : '#888';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>AstraMemory Dashboard</title>
<style>${CSS}</style>
</head>
<body>
<h1>AstraMemory Local</h1>
<span class="meta">
  v${esc(PKG_VERSION)} &middot;
  schema ${SCHEMA_VERSION} &middot;
  wire: ${esc(WIRE_VERSIONS_SUPPORTED.join(', '))} &middot;
  <span style="color:${statusColor}">${label}</span> &#9679;
</span>

<nav>
  <span class="active">Mission Control</span>
  <a href="/dashboard/jobs">Jobs</a>
  <a href="/dashboard/consolidation">Consolidation</a>
  <a href="/dashboard/search">Search</a>
  <span class="asof">as of ${esc(now)}</span>
</nav>

<section>
${renderBanner(data.health)}
</section>

<section>
${renderPipeline(data)}
</section>

<section class="strips">
${renderJobsStrip(data)}
${renderConsolidationStrip(data)}
${renderProvidersStrip(data)}
</section>

<section class="strips2">
${renderBudgetTile(data, dailyCap)}
${renderUsefulnessTile(data.usefulness)}
</section>

<section>
<h2 style="font-size:14px;color:#aaa;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Recent activity / errors</h2>
${renderActivityFeed(data)}
</section>
</body>
</html>`;
}
