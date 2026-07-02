/**
 * dashboard-html.ts — server-side HTML renderer for /dashboard.
 *
 * Zero runtime dependencies: pure string concatenation.
 * No JS in output. <meta refresh> drives auto-poll.
 * Target: < 20 KB gzipped.
 */

import type { DashboardData } from '../queries/dashboard.js';
import type { Config } from '../../config/config.js';
import { PKG_VERSION, WIRE_VERSIONS_SUPPORTED, SCHEMA_VERSION } from '../lib/wire-meta.js';

// ---------------------------------------------------------------------------
// Helpers
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

function fmtDate(epochMs: number): string {
  try {
    return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
  } catch {
    return 'unknown';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function fmtAgeMs(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

function budgetColor(spend: number, cap: number): string {
  if (cap <= 0) return '#888';
  const pct = spend / cap;
  if (pct >= 0.8) return '#e74c3c';
  if (pct >= 0.5) return '#f39c12';
  return '#2ecc71';
}

function jobStateColor(state: string, count: number): string {
  if (state === 'poison' && count > 0) return '#e74c3c';
  if (state === 'pending' && count > 3) return '#f39c12';
  if (state === 'completed') return '#2ecc71';
  if (state === 'running') return '#3498db';
  if (state === 'failed') return '#e74c3c';
  if (state === 'paused') return '#888';
  return '#e0e0e0';
}

// ---------------------------------------------------------------------------
// Inline CSS
// ---------------------------------------------------------------------------

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a1a;color:#e0e0e0;font-family:monospace;font-size:13px;line-height:1.5;padding:16px}
h1{font-size:18px;color:#fff;margin-bottom:4px}
h2{font-size:14px;color:#aaa;margin:20px 0 8px;border-bottom:1px solid #333;padding-bottom:4px;text-transform:uppercase;letter-spacing:.05em}
.meta{color:#888;font-size:12px;margin-bottom:16px}
.meta span{color:#ccc}
section{margin-bottom:24px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#222;color:#aaa;text-align:left;padding:5px 8px;position:sticky;top:0;z-index:1;font-weight:normal;text-transform:uppercase;letter-spacing:.04em}
td{padding:4px 8px;border-bottom:1px solid #252525;font-variant-numeric:tabular-nums}
tr:nth-child(odd) td{background:#1e1e1e}
tr:hover td{background:#242424}
.badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px}
.bar-wrap{background:#222;border-radius:2px;height:14px;margin:2px 0;min-width:40px}
.bar{background:#3a7bd5;height:14px;border-radius:2px;min-width:3px;display:inline-block}
.bar-label{display:inline-block;width:90px;color:#aaa}
.bar-row{display:flex;align-items:center;gap:8px;margin:3px 0}
.hist-row{display:flex;align-items:flex-end;gap:2px;height:60px;margin-top:4px}
.hist-bar-wrap{display:flex;flex-direction:column;align-items:center;gap:2px}
.hist-bar{background:#3a7bd5;width:24px;min-height:2px}
.hist-label{color:#666;font-size:10px;white-space:nowrap;transform:rotate(-60deg);transform-origin:top left;margin-left:8px;margin-top:4px}
.hist-count{color:#888;font-size:10px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.trunc{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ok{color:#2ecc71}
.warn{color:#f39c12}
.err{color:#e74c3c}
.muted{color:#666}
.pending-box{padding:8px 12px;background:#222;border-radius:4px;display:inline-block}
`.trim();

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderHeader(ts: string): string {
  const wires = WIRE_VERSIONS_SUPPORTED.join(', ');
  return `
<h1>AstraMemory Local — Dashboard</h1>
<div class="meta">
  <span>v${esc(PKG_VERSION)}</span> &middot;
  wire: <span>${esc(wires)}</span> &middot;
  schema: <span>${SCHEMA_VERSION}</span> &middot;
  as of: <span>${esc(ts)}</span>
</div>`;
}

function renderMemoryCounts(counts: DashboardData['memoryCounts']): string {
  if (counts.length === 0) {
    return '<p class="muted">No memories stored yet.</p>';
  }
  const max = Math.max(...counts.map(c => c.count), 1);
  const rows = counts.map(c => {
    const pct = Math.max(4, Math.round((c.count / max) * 200));
    return `
    <div class="bar-row">
      <span class="bar-label">${esc(c.type)}</span>
      <div class="bar-wrap" style="flex:1"><div class="bar" style="width:${pct}px"></div></div>
      <span class="num" style="width:50px">${c.count}</span>
    </div>`;
  }).join('');
  return `<div>${rows}</div>`;
}

function renderRecentMemories(rows: DashboardData['recentMemories']): string {
  if (rows.length === 0) {
    return '<p class="muted">No memories yet.</p>';
  }
  const trs = rows.map(r => {
    const text = esc(truncate(r.text, 120));
    const time = fmtTime(r.created_at);
    const imp = r.importance.toFixed(2);
    const conf = r.confidence.toFixed(2);
    const sid = r.session_id ? esc(r.session_id.slice(0, 8)) : '<span class="muted">—</span>';
    return `<tr>
      <td class="muted" style="width:90px">${esc(time)}</td>
      <td style="width:70px"><span class="badge" style="background:#2a2a2a;color:#aaa">${esc(r.type)}</span></td>
      <td class="trunc">${text}</td>
      <td class="num" style="width:48px">${imp}</td>
      <td class="num" style="width:48px">${conf}</td>
      <td style="width:80px" class="muted">${sid}</td>
    </tr>`;
  }).join('');
  return `<table>
  <thead><tr>
    <th>Time</th><th>Type</th><th>Text</th><th class="num">Imp</th><th class="num">Conf</th><th>Session</th>
  </tr></thead>
  <tbody>${trs}</tbody>
</table>`;
}

function renderJobStates(states: DashboardData['jobStates']): string {
  if (states.length === 0) {
    return '<p class="muted">No jobs in queue.</p>';
  }
  const items = states.map(s => {
    const color = jobStateColor(s.state, s.count);
    return `<span class="badge" style="background:${color}22;color:${color};border:1px solid ${color}44;margin-right:8px">
      ${esc(s.state)}: ${s.count}
    </span>`;
  }).join('');
  return `<div style="padding:8px 0">${items}</div>`;
}

function renderHourlyThroughput(rows: DashboardData['hourlyThroughput']): string {
  if (rows.length === 0) {
    return '<p class="muted">No memories in the last 24h.</p>';
  }
  const max = Math.max(...rows.map(r => r.count), 1);
  const bars = rows.map(r => {
    const h = Math.max(2, Math.round((r.count / max) * 56));
    const label = r.hour.slice(11, 13) + 'h'; // HH
    return `<div class="hist-bar-wrap">
      <span class="hist-count">${r.count}</span>
      <div class="hist-bar" style="height:${h}px"></div>
      <span class="hist-label">${esc(label)}</span>
    </div>`;
  }).join('');
  return `<div class="hist-row">${bars}</div>`;
}

function renderProviders(providers: DashboardData['providers']): string {
  if (providers.length === 0) {
    return '<p class="muted">No providers registered.</p>';
  }
  const trs = providers.map(p => {
    const ok = p.last_health_ok ? '<span class="ok">OK</span>' : '<span class="err">FAIL</span>';
    const checked = p.last_check_at ? esc(fmtDate(p.last_check_at)) : '<span class="muted">never</span>';
    return `<tr>
      <td>${esc(p.provider)}</td>
      <td>${esc(p.model)}</td>
      <td class="num">${p.dim ?? '<span class="muted">—</span>'}</td>
      <td>${ok}</td>
      <td class="muted">${checked}</td>
    </tr>`;
  }).join('');
  return `<table>
  <thead><tr><th>Provider</th><th>Model</th><th class="num">Dim</th><th>Health</th><th>Last check</th></tr></thead>
  <tbody>${trs}</tbody>
</table>`;
}

function renderBudget(data: DashboardData, dailyCap: number): string {
  const todayUsd = data.todaySpend?.usd_total ?? 0;
  const todayCalls = data.todaySpend?.calls ?? 0;
  const color = budgetColor(todayUsd, dailyCap);
  const pct = dailyCap > 0 ? Math.min(100, Math.round((todayUsd / dailyCap) * 100)) : 0;
  return `<div style="display:flex;gap:32px;flex-wrap:wrap">
  <div>
    <div class="muted" style="font-size:11px;margin-bottom:2px">TODAY</div>
    <div style="font-size:20px;color:${color}">$${todayUsd.toFixed(4)}</div>
    <div class="muted">${todayCalls} calls &middot; cap $${dailyCap.toFixed(2)} &middot; ${pct}% used</div>
    <div class="bar-wrap" style="width:160px;margin-top:6px"><div class="bar" style="width:${Math.max(2,pct*1.6)}px;background:${color}"></div></div>
  </div>
  <div>
    <div class="muted" style="font-size:11px;margin-bottom:2px">MTD</div>
    <div style="font-size:20px;color:#e0e0e0">$${data.mtdSpend.toFixed(4)}</div>
    <div class="muted">${data.mtdCalls} calls</div>
  </div>
</div>`;
}

function fmtRate(rate: number | null): string {
  return rate === null ? '<span class="muted">n/a</span>' : `${(rate * 100).toFixed(1)}%`;
}

function renderUsefulness(overall: DashboardData['usefulness'], byType: DashboardData['usefulnessByType']): string {
  const summary = `<div style="display:flex;gap:32px;flex-wrap:wrap;margin-bottom:8px">
  <div>
    <div class="muted" style="font-size:11px;margin-bottom:2px">SERVED (7D)</div>
    <div style="font-size:20px;color:#e0e0e0">${overall.served}</div>
  </div>
  <div>
    <div class="muted" style="font-size:11px;margin-bottom:2px">USED (7D)</div>
    <div style="font-size:20px;color:#e0e0e0">${overall.used}</div>
  </div>
  <div>
    <div class="muted" style="font-size:11px;margin-bottom:2px">RATE (7D)</div>
    <div style="font-size:20px;color:#3a7bd5">${fmtRate(overall.rate)}</div>
  </div>
</div>`;

  if (byType.length === 0) {
    return `${summary}<p class="muted">No usefulness events by type yet.</p>`;
  }

  const trs = byType.map(t => `<tr>
      <td>${esc(t.type)}</td>
      <td class="num">${t.served}</td>
      <td class="num">${t.used}</td>
      <td class="num">${fmtRate(t.rate)}</td>
    </tr>`).join('');
  const table = `<table>
  <thead><tr><th>Type</th><th class="num">Served</th><th class="num">Used</th><th class="num">Rate</th></tr></thead>
  <tbody>${trs}</tbody>
</table>`;
  return `${summary}${table}`;
}

function renderPending(p: DashboardData['pendingDir']): string {
  if (p.count === 0) {
    return '<div class="pending-box"><span class="ok">0 pending</span></div>';
  }
  const age = p.oldestAgeMs != null ? ` &middot; oldest ${esc(fmtAgeMs(p.oldestAgeMs))}` : '';
  return `<div class="pending-box"><span class="warn">${p.count} pending${age}</span></div>`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function renderDashboard(data: DashboardData, config: Config): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const dailyCap = config.budget.daily_usd;

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
${renderHeader(now)}

<section>
<h2>Memory counts by type</h2>
${renderMemoryCounts(data.memoryCounts)}
</section>

<section>
<h2>Recent captures (last 25)</h2>
${renderRecentMemories(data.recentMemories)}
</section>

<section>
<h2>Job queue state</h2>
${renderJobStates(data.jobStates)}
</section>

<section>
<h2>Distill throughput — last 24h</h2>
${renderHourlyThroughput(data.hourlyThroughput)}
</section>

<section>
<h2>Provider state</h2>
${renderProviders(data.providers)}
</section>

<section>
<h2>Usefulness</h2>
${renderUsefulness(data.usefulness, data.usefulnessByType)}
</section>

<section>
<h2>Budget</h2>
${renderBudget(data, dailyCap)}
</section>

<section>
<h2>Pending queue</h2>
${renderPending(data.pendingDir)}
</section>
</body>
</html>`;
}
