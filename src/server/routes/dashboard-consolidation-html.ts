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
      const pending = proposals.list('pending');

      return reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(renderPage(pending, memories));
    });
  };
}

function renderExcerpt(memoryId: string, memories: MemoryRepo): string {
  const mem = memories.get(memoryId);
  if (!mem) return '<span class="muted">(memory not found)</span>';
  return esc(truncate(mem.text, 140));
}

function renderRow(p: ConsolidationProposal, memories: MemoryRepo): string {
  const id = esc(p.id);
  const kind = esc(p.kind);
  const sim = p.similarity.toFixed(2);
  const age = esc(fmtAge(Date.now() - p.created_at));
  const acceptAction = `/consolidation/proposals/${encodeURIComponent(p.id)}/accept`;
  const rejectAction = `/consolidation/proposals/${encodeURIComponent(p.id)}/reject`;

  return `<tr>
    <td>${id}</td>
    <td>${kind}</td>
    <td class="num">${sim}</td>
    <td class="trunc">${renderExcerpt(p.winner_id, memories)}</td>
    <td class="trunc">${renderExcerpt(p.loser_id, memories)}</td>
    <td class="muted">${age}</td>
    <td>
      <form method="post" action="${esc(acceptAction)}" style="display:inline">
        <button type="submit">accept</button>
      </form>
      <form method="post" action="${esc(rejectAction)}" style="display:inline">
        <button type="submit">reject</button>
      </form>
    </td>
  </tr>`;
}

function renderBody(pending: ConsolidationProposal[], memories: MemoryRepo): string {
  if (pending.length === 0) {
    return '<p class="muted">No pending proposals.</p>';
  }
  const rows = pending.map(p => renderRow(p, memories)).join('');
  return `<table>
  <thead><tr>
    <th>ID</th><th>Kind</th><th class="num">Sim</th><th>Winner</th><th>Loser</th><th>Age</th><th>Actions</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function renderPage(pending: ConsolidationProposal[], memories: MemoryRepo): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AstraMemory Dashboard — Consolidation</title>
<style>${CSS}</style>
</head>
<body>
<h1>Consolidation — pending: ${pending.length}</h1>
${renderBody(pending, memories)}
</body>
</html>`;
}
