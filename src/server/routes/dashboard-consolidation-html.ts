/**
 * GET /dashboard/consolidation — pending consolidation proposal list with
 * accept/reject (FEAT-410 wave 2, SLICE-410-2; replaces SLICE-410-1's stub
 * render internals).
 *
 * Each row is a plain `<form method="post">` targeting the EXISTING
 * `/consolidation/proposals/:id/accept|reject` endpoints
 * (src/server/routes/consolidation.ts) verbatim — no new mutation surface,
 * zero JS. Because those endpoints respond with JSON rather than a redirect
 * back to this page, resolving a proposal navigates away from the
 * dashboard; the operator returns to `/dashboard/consolidation` (nav link or
 * back button) to see the list reflect the new status. This zero-JS,
 * full-reload UX is the explicit design tradeoff recorded in
 * `.claude/artifacts/crew/runs/2026-07-04-dashboard-redesign-design.md` §7.
 *
 * Auth mirrors src/server/routes/dashboard.ts (Bearer header or the
 * HttpOnly `astramem_dash` cookie bootstrapped there) but the check is
 * duplicated locally by design — each dashboard page module stays
 * independently reviewable, and wave-2 slices are forbidden from touching
 * app.ts, so the auth wrapper here must be self-contained.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '../../storage/db.js';
import { ProposalRepo, type ConsolidationProposal } from '../../consolidate/proposals.js';
import { MemoryRepo } from '../../storage/memories.js';

const COOKIE_NAME = 'astramem_dash';
const RESOLVED_LIMIT = 100;

type ProposalStatus = ConsolidationProposal['status'];

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// Locally duplicated rather than imported from dashboard-html.ts — that
// module is module-private by design (see file header + slice scope).
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function fmtAge(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return `${Math.floor(clamped / 1000)}s`;
  if (clamped < 3_600_000) return `${Math.floor(clamped / 60_000)}m`;
  return `${Math.floor(clamped / 3_600_000)}h`;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a1a;color:#e0e0e0;font-family:monospace;font-size:13px;line-height:1.5;padding:16px}
h1{font-size:18px;color:#fff;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#222;color:#aaa;text-align:left;padding:5px 8px;font-weight:normal;text-transform:uppercase;letter-spacing:.04em}
td{padding:5px 8px;border-bottom:1px solid #252525;vertical-align:top}
tr:nth-child(odd) td{background:#1e1e1e}
.num{text-align:right;font-variant-numeric:tabular-nums}
.trunc{max-width:260px;overflow-wrap:break-word}
.muted{color:#666}
button{font-family:monospace;font-size:12px;padding:2px 8px;margin-right:4px;background:#2a2a2a;color:#e0e0e0;border:1px solid #444;border-radius:3px;cursor:pointer}
button:hover{background:#333}
nav{display:flex;gap:16px;margin:8px 0 16px;padding-bottom:8px;border-bottom:1px solid #333;font-size:12px}
nav a{color:#888;text-decoration:none}
nav a:hover{color:#3a7bd5}
nav .active{color:#fff;font-weight:bold}
.tabs{margin:0 0 10px;display:flex;gap:14px}
.tabs a{color:#3a7bd5;text-decoration:none}
.tabs .active{color:#fff;font-weight:bold}
.note{color:#666;font-size:11px;margin-bottom:10px}
.kind-badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
.kind-merge{background:#233;color:#7ec8e3}
.kind-contradiction{background:#3a1f1f;color:#e38a7e}
`.trim();

/** `db` backs the real proposal + memory lookups (SLICE-410-1's stub
 *  accepted but ignored it, keeping this factory's signature stable). */
export function dashboardConsolidationRoute(db: DB, token: string) {
  return async (app: FastifyInstance) => {
    app.get('/dashboard/consolidation', async (req, reply) => {
      const authHeader = req.headers.authorization;
      const bearerOk = authHeader === `Bearer ${token}`;
      const cookieOk = readCookie(req, COOKIE_NAME) === token;

      if (!bearerOk && !cookieOk) {
        return reply
          .code(401)
          .header('content-type', 'text/plain; charset=utf-8')
          .send('401 Unauthorized');
      }

      const proposals = new ProposalRepo(db);
      const memories = new MemoryRepo(db);

      const q = req.query as Record<string, string | undefined>;
      const status: ProposalStatus =
        q.status === 'accepted' || q.status === 'rejected' ? q.status : 'pending';

      const counts: Record<ProposalStatus, number> = {
        pending: proposals.list('pending').length,
        accepted: proposals.list('accepted').length,
        rejected: proposals.list('rejected').length,
      };
      // Resolved lists show newest-first (most recent auto-sweep results on
      // top) and are capped — the operator cares about "what just happened",
      // not the full history.
      let rows = proposals.list(status);
      if (status !== 'pending') {
        rows = rows
          .slice()
          .sort((a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0))
          .slice(0, RESOLVED_LIMIT);
      }

      return reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(renderPage(status, counts, rows, memories));
    });
  };
}

function renderExcerpt(memoryId: string, memories: MemoryRepo): string {
  const mem = memories.get(memoryId);
  if (!mem) return '<span class="muted">(memory not found)</span>';
  return esc(truncate(mem.text, 140));
}

function renderKindBadge(kind: ConsolidationProposal['kind']): string {
  return `<span class="kind-badge kind-${esc(kind)}">${esc(kind)}</span>`;
}

function renderRow(p: ConsolidationProposal, memories: MemoryRepo): string {
  const id = esc(p.id);
  const sim = p.similarity.toFixed(2);
  const age = esc(fmtAge(Date.now() - p.created_at));

  let lastCell: string;
  if (p.status === 'pending') {
    const acceptAction = `/consolidation/proposals/${encodeURIComponent(p.id)}/accept`;
    const rejectAction = `/consolidation/proposals/${encodeURIComponent(p.id)}/reject`;
    lastCell = `
      <form method="post" action="${esc(acceptAction)}" style="display:inline">
        <button type="submit">accept</button>
      </form>
      <form method="post" action="${esc(rejectAction)}" style="display:inline">
        <button type="submit">reject</button>
      </form>`;
  } else {
    const resolvedAge = p.resolved_at !== null ? fmtAge(Date.now() - p.resolved_at) : '?';
    lastCell = `<span class="muted">${esc(p.status)} ${esc(resolvedAge)} ago</span>`;
  }

  return `<tr>
    <td>${id}</td>
    <td>${renderKindBadge(p.kind)}</td>
    <td class="num">${sim}</td>
    <td class="trunc">${renderExcerpt(p.winner_id, memories)}</td>
    <td class="trunc">${renderExcerpt(p.loser_id, memories)}</td>
    <td class="muted">${age}</td>
    <td>${lastCell}</td>
  </tr>`;
}

function renderTabs(status: ProposalStatus, counts: Record<ProposalStatus, number>): string {
  const tab = (s: ProposalStatus): string => {
    const label = `${s} (${counts[s]})`;
    if (s === status) return `<span class="active">${esc(label)}</span>`;
    return `<a href="/dashboard/consolidation?status=${s}">${esc(label)}</a>`;
  };
  return `<div class="tabs">${tab('pending')} ${tab('accepted')} ${tab('rejected')}</div>`;
}

function renderBody(status: ProposalStatus, rows: ConsolidationProposal[], memories: MemoryRepo): string {
  if (rows.length === 0) {
    return `<p class="muted">No ${esc(status)} proposals.</p>`;
  }
  const lastHeader = status === 'pending' ? 'Actions' : 'Resolved';
  const capNote = rows.length === RESOLVED_LIMIT && status !== 'pending'
    ? `<p class="muted">showing ${RESOLVED_LIMIT} most recently resolved</p>` : '';
  return `${capNote}<table>
  <thead><tr>
    <th>ID</th><th>Kind</th><th class="num">Sim</th><th>Winner</th><th>Loser</th><th>Age</th><th>${lastHeader}</th>
  </tr></thead>
  <tbody>${rows.map(p => renderRow(p, memories)).join('')}</tbody>
</table>`;
}

function renderPage(
  status: ProposalStatus,
  counts: Record<ProposalStatus, number>,
  rows: ConsolidationProposal[],
  memories: MemoryRepo,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AstraMemory Dashboard — Consolidation</title>
<style>${CSS}</style>
</head>
<body>
<h1>Consolidation — ${esc(status)}: ${counts[status]}</h1>
<nav><a href="/dashboard">Mission Control</a> <a href="/dashboard/jobs">Jobs</a> <span class="active">Consolidation</span> <a href="/dashboard/search">Search</a> <a href="/dashboard/api">API</a></nav>
${renderTabs(status, counts)}
<p class="note">accepted = merged (auto containment-sweep or manual). Direct auto-merges at &ge;0.95 similarity or exact-containment never create proposals — they land straight in memory history.</p>
${renderBody(status, rows, memories)}
</body>
</html>`;
}
