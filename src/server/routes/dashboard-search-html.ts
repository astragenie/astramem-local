/**
 * GET /dashboard/search — search debug page (FEAT-410 wave 2, SLICE-410-6).
 *
 * Plain GET `<form>` (query in the URL) rendering the per-candidate fusion
 * score table from SLICE-410-3's `debug: true` search() path, plus the
 * current fuse.ts weights (src/config/config.ts `search` defaults). Zero JS.
 *
 * Auth is the shared `checkDashboardAuth` helper (dashboard-auth.ts) — Bearer
 * header, the HttpOnly `astramem_dash` cookie bootstrapped by
 * src/server/routes/dashboard.ts, or (when active) devNoAuth's loopback-only
 * bypass. HTML escaping is likewise duplicated locally rather than importing
 * dashboard-html.ts's `esc()` (SLICE-410-6 scope: this file + its tests only).
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import type { EmbedProvider } from '../../contracts/index.js';
import { search, type SearchDebugHit, type SearchFilters } from '../../search/search.js';
import { defaultConfig, type Config } from '../../config/config.js';
import { checkDashboardAuth } from './dashboard-auth.js';
import { renderDashboardNav, DASHBOARD_NAV_CSS } from './dashboard-nav.js';
import { queryExtractProfilesBySession } from '../queries/dashboard.js';

const RESULT_LIMIT = 20;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "0.4" -> ".4" to match the design doc's compact weight notation (α.4 β.4 …). */
function fmtWeight(n: number): string {
  return String(n).replace(/^0\./, '.').replace(/^-0\./, '-.');
}

function fmtScore(n: number): string {
  return n.toFixed(3);
}

interface HitContext {
  project: string | null;
  profile: string | null;
}

/** Batched project/profile lookup for the fusion-debug hit list — SearchDebugHit
 *  only carries `id` + score intermediates (see its doc comment: purely a
 *  fusion-breakdown projection), so the dashboard's project/profile columns
 *  are resolved here in exactly two queries total (never per-row): one
 *  `memories` IN-clause lookup for id -> {project, session_id}, then the
 *  shared queryExtractProfilesBySession helper (also used by the main
 *  dashboard's activity feed) for session_id -> profile. */
function queryHitContext(db: DB, hits: SearchDebugHit[]): Map<string, HitContext> {
  const result = new Map<string, HitContext>();
  if (hits.length === 0) return result;

  const ids = hits.map(h => h.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, project, session_id FROM memories WHERE id IN (${placeholders})
  `).all(...ids) as Array<{ id: string; project: string | null; session_id: string | null }>;

  const profileBySession = queryExtractProfilesBySession(db, rows.map(r => r.session_id));
  for (const row of rows) {
    result.set(row.id, {
      project: row.project,
      profile: row.session_id !== null ? profileBySession.get(row.session_id) ?? null : null,
    });
  }
  return result;
}

export function dashboardSearchRoute(db: DB, embed: EmbedProvider, token: string, devNoAuthActive = false) {
  return async (app: FastifyInstance) => {
    app.get('/dashboard/search', async (req, reply) => {
      const authResult = checkDashboardAuth(req, token, devNoAuthActive);
      if (!authResult.allowed) {
        return reply
          .code(authResult.status)
          .header('content-type', 'text/plain; charset=utf-8')
          .send(authResult.body);
      }

      const q = req.query as Record<string, string | undefined>;
      const rawQuery = q.query;
      const weights = defaultConfig().search;

      // Optional filter fields — every implemented search() filter mode is
      // exposed: entity (FEAT-402), as_of temporal time-travel (FEAT-401),
      // since lower bound, type list. Empty strings mean "not set".
      const filterInputs = {
        entity: q.entity?.trim() || undefined,
        type: q.type?.trim() || undefined,
        as_of: q.as_of?.trim() || undefined,
        since: q.since?.trim() || undefined,
      };
      const filters: SearchFilters = {};
      if (filterInputs.entity) filters.entity = filterInputs.entity;
      if (filterInputs.type) filters.type = filterInputs.type.split(',').map(s => s.trim()).filter(Boolean);
      // datetime-local values ("2026-07-04T09:30") parse as local time —
      // matching the operator's clock on this local-first daemon.
      if (filterInputs.as_of) {
        const t = new Date(filterInputs.as_of).getTime();
        if (!Number.isNaN(t)) filters.as_of = t;
      }
      if (filterInputs.since) {
        const t = new Date(filterInputs.since).getTime();
        if (!Number.isNaN(t)) filters.since = t;
      }

      // AC-2: no `query` key at all → initial load, form + weights only.
      // Any present value (including "") is treated as a submitted search
      // so a zero-candidate result renders the explicit AC-3 empty state
      // rather than silently looking like the initial load.
      const ranSearch = rawQuery !== undefined;
      let hits: SearchDebugHit[] = [];
      let hitContext: Map<string, HitContext> = new Map();
      if (ranSearch) {
        hits = await search(rawQuery, filters, RESULT_LIMIT, { db, embed, weights, debug: true });
        hitContext = queryHitContext(db, hits);
      }

      return reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(renderPage(rawQuery, weights, ranSearch, hits, filterInputs, hitContext));
    });
  };
}

function renderWeights(weights: Config['search']): string {
  return `&alpha;${fmtWeight(weights.alpha)} &beta;${fmtWeight(weights.beta)} `
    + `&gamma;${fmtWeight(weights.gamma)} &delta;${fmtWeight(weights.delta)} `
    + `&epsilon;${fmtWeight(weights.epsilon)} &zeta;${fmtWeight(weights.zeta)} `
    + `&eta;${fmtWeight(weights.eta)}`;
}

function renderTable(hits: SearchDebugHit[], hitContext: Map<string, HitContext>): string {
  const rows = hits.map((h, i) => {
    const ctx = hitContext.get(h.id);
    const project = ctx?.project ? esc(ctx.project) : '—';
    const profile = ctx?.profile ? esc(ctx.profile) : '—';
    return `
      <tr>
        <td>${esc(h.id.slice(0, 8))}&hellip;</td>
        <td>${esc(h.source)}</td>
        <td>${fmtScore(h.bm25.normalized)}</td>
        <td>${fmtScore(h.cosine.normalized)}</td>
        <td>${fmtScore(h.importance)}</td>
        <td>${fmtScore(h.freshness)}</td>
        <td>${fmtScore(h.score)}</td>
        <td>${i + 1}</td>
        <td>${project}</td>
        <td>${profile}</td>
      </tr>`;
  }).join('');

  return `<table>
    <thead>
      <tr>
        <th>id</th><th>source</th><th>bm25(norm)</th><th>cosine(norm)</th>
        <th>importance</th><th>freshness</th><th>fused</th><th>rank</th>
        <th>project</th><th>profile</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>`;
}

function renderResults(ranSearch: boolean, hits: SearchDebugHit[], hitContext: Map<string, HitContext>): string {
  if (!ranSearch) return '';
  if (hits.length === 0) return '<p class="empty">no results</p>';
  return renderTable(hits, hitContext);
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a1a;color:#e0e0e0;font-family:monospace;font-size:13px;line-height:1.5;padding:16px}
h1{font-size:18px;color:#fff;margin-bottom:12px}
form{margin-bottom:8px}
input[type=text]{background:#0f0f0f;color:#e0e0e0;border:1px solid #333;padding:4px 8px;width:320px}
button{background:#2a2a2a;color:#e0e0e0;border:1px solid #444;padding:4px 10px;margin-left:4px}
.weights{color:#888;margin-bottom:16px}
${DASHBOARD_NAV_CSS}
.filters{margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;color:#888}
.filters input{width:170px}
.filters input[type=datetime-local]{width:200px;background:#0f0f0f;color:#e0e0e0;border:1px solid #333;padding:3px 6px}
.hint{color:#666;font-size:11px;margin-top:6px}
table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid #333;padding:4px 8px;text-align:left}
th{color:#aaa;text-transform:uppercase;font-size:11px;letter-spacing:.05em}
.empty{color:#888;margin-top:12px}
`;

interface FilterInputs {
  entity?: string;
  type?: string;
  as_of?: string;
  since?: string;
}

function renderPage(rawQuery: string | undefined, weights: Config['search'], ranSearch: boolean, hits: SearchDebugHit[], f: FilterInputs, hitContext: Map<string, HitContext>): string {
  const queryValue = esc(rawQuery ?? '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AstraMemory Dashboard — Search debug</title>
<style>${CSS}</style>
</head>
<body>
<h1>Search debug</h1>
${renderDashboardNav('search')}
<form method="get" action="/dashboard/search">
  <input type="text" name="query" value="${queryValue}" placeholder="query...">
  <button type="submit">run</button>
  <div class="filters">
    <label>entity <input type="text" name="entity" value="${esc(f.entity ?? '')}" placeholder="entity name"></label>
    <label>type <input type="text" name="type" value="${esc(f.type ?? '')}" placeholder="fact,decision,…"></label>
    <label>as of <input type="datetime-local" name="as_of" value="${esc(f.as_of ?? '')}"></label>
    <label>since <input type="datetime-local" name="since" value="${esc(f.since ?? '')}"></label>
  </div>
  <p class="hint">modes: hybrid FTS(bm25)+vector fusion always on &middot; entity filter (exact, then substring) &middot; as-of = bitemporal time-travel &middot; since = created_at lower bound &middot; type = comma-separated list</p>
</form>
<p class="weights">weights: ${renderWeights(weights)}</p>
${renderResults(ranSearch, hits, hitContext)}
</body>
</html>`;
}
