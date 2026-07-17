/**
 * GET /dashboard/providers (FEAT-539) — every pipeline role's configured
 * provider/model + live up/down status, in one place.
 *
 * Motivation: the operator asked why the dashboard showed no LLM/provider
 * status at all. FEAT-538 already computes real per-provider health (up/down
 * from actual chat() auth/quota/5xx failures, not a probe — see
 * src/providers/llm/health-tracking.ts's module doc comment) and surfaces it
 * on `GET /health` as `provider_health.{extraction,compaction}`. This route
 * is a pure READ of that same registry (`getProviderHealthEntry`) — it never
 * probes a provider itself and never adds a second source of truth.
 *
 * Six pipeline roles are shown, not just the two `/health` wires up:
 *   embedding, compaction, extraction, judge (contradiction detection),
 *   extractionPassB, atomTriage.
 *
 * `judge`/`extractionPassB`/`atomTriage` all default to "ride extraction" —
 * unset `provider`/`model` means the SAME provider instance as
 * `config.llm.extraction` (shared rate-limit bucket, shared health-registry
 * entry, see health-tracking.ts's doc comment). Rendering those rows with
 * their own green dot when un-overridden would look like three independently
 * monitored providers when it is really one signal wearing three names — so
 * an un-overridden (or mode:'off'/inactive) role renders GREY with a "rides
 * extraction" / "disabled" note instead of a false-green independent status,
 * even when the extraction provider it would ride is currently up.
 *
 * `embedding` is not an LLM-chat role (no ProviderHealthEntry) — its status
 * comes from `healthState.embed` (the same field the main dashboard's
 * "Embedding" strip and `/health`'s `embed` block already read), so it always
 * shows its own real up/down/starting rather than grey.
 */

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config/config.js';
import type { HealthState } from '../health-state.js';
import type { LLMProviderName } from '../../contracts/llm.js';
import { getProviderHealthEntry, type ProviderFailureKind } from '../../providers/llm/health-tracking.js';
import { checkDashboardAuth } from './dashboard-auth.js';
import { renderDashboardNav, DASHBOARD_NAV_CSS } from './dashboard-nav.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export type RoleDotStatus = 'up' | 'down' | 'grey';

export interface ProviderRoleRow {
  role: string;
  provider: string;
  model: string;
  status: RoleDotStatus;
  /** Why the row is grey (rides-extraction / disabled) — empty for up/down rows. */
  note: string;
  reason: ProviderFailureKind | null;
  /** Failure remedy (down) or last embed error (embedding, down) — null otherwise. */
  message: string | null;
}

/** A role with an optional provider/model override that defaults to riding
 *  `llm.extraction` when unset (judge / extractionPassB / atomTriage all
 *  share this exact shape) — resolved once per row so the grey-vs-live
 *  decision and the provider lookup use the identical inputs. */
function resolveRidingRole(
  role: string,
  active: boolean,
  inactiveNote: string,
  override: { provider?: LLMProviderName; model?: string } | undefined,
  extraction: { provider: LLMProviderName; model: string },
): ProviderRoleRow {
  const overridden = override?.provider !== undefined;
  const provider = override?.provider ?? extraction.provider;
  const model = override?.model ?? extraction.model;

  if (!active) {
    return { role, provider, model, status: 'grey', note: inactiveNote, reason: null, message: null };
  }
  if (!overridden) {
    return { role, provider, model, status: 'grey', note: 'rides extraction (no override)', reason: null, message: null };
  }
  const entry = getProviderHealthEntry(provider);
  return {
    role,
    provider,
    model,
    status: entry.status,
    note: '',
    reason: entry.reason,
    message: entry.message,
  };
}

/** AC: single source of truth — every non-embedding row's up/down comes from
 *  FEAT-538's `getProviderHealthEntry` registry (the same one `/health`
 *  reads), never a separate probe. */
export function resolveProviderRows(config: Config, healthState?: HealthState): ProviderRoleRow[] {
  const embed = healthState?.embed;
  const embeddingRow: ProviderRoleRow = {
    role: 'embedding',
    provider: config.embedding.provider,
    model: config.embedding.model,
    status: embed === undefined || embed.ok === null ? 'grey' : embed.ok ? 'up' : 'down',
    note: embed === undefined || embed.ok === null ? 'starting / no health data' : '',
    reason: null,
    message: embed?.lastError ?? null,
  };

  const compactionEntry = getProviderHealthEntry(config.llm.compaction.provider);
  const compactionRow: ProviderRoleRow = {
    role: 'compaction',
    provider: config.llm.compaction.provider,
    model: config.llm.compaction.model,
    status: compactionEntry.status,
    note: '',
    reason: compactionEntry.reason,
    message: compactionEntry.message,
  };

  const extractionEntry = getProviderHealthEntry(config.llm.extraction.provider);
  const extractionRow: ProviderRoleRow = {
    role: 'extraction',
    provider: config.llm.extraction.provider,
    model: config.llm.extraction.model,
    status: extractionEntry.status,
    note: '',
    reason: extractionEntry.reason,
    message: extractionEntry.message,
  };

  const extraction = { provider: config.llm.extraction.provider, model: config.llm.extraction.model };

  const cd = config.consolidation.contradictionDetection;
  const judgeRow = resolveRidingRole(
    'judge',
    cd.mode !== 'off',
    `disabled (mode: ${cd.mode})`,
    cd.provider !== undefined || cd.model !== undefined ? { provider: cd.provider, model: cd.model } : undefined,
    extraction,
  );

  const passB = config.distill.extractionPassB;
  const passBRow = resolveRidingRole(
    'extractionPassB',
    config.distill.extractionPasses === 2,
    `inactive (extractionPasses: ${config.distill.extractionPasses})`,
    passB,
    extraction,
  );

  const triage = config.distill.atomTriage;
  const triageRow = resolveRidingRole(
    'atomTriage',
    triage.mode !== 'off',
    `disabled (mode: ${triage.mode})`,
    triage.provider !== undefined || triage.model !== undefined ? { provider: triage.provider, model: triage.model } : undefined,
    extraction,
  );

  return [embeddingRow, compactionRow, extractionRow, judgeRow, passBRow, triageRow];
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a1a;color:#e0e0e0;font-family:monospace;font-size:13px;line-height:1.5;padding:16px}
h1{font-size:18px;color:#fff;margin-bottom:4px}
${DASHBOARD_NAV_CSS}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
th{background:#222;color:#aaa;text-align:left;padding:5px 8px;font-weight:normal;text-transform:uppercase;letter-spacing:.04em}
td{padding:6px 8px;border-bottom:1px solid #252525}
tr:nth-child(odd) td{background:#1e1e1e}
tr:hover td{background:#242424}
.dot{font-size:14px}
.dot-up{color:#2ecc71}
.dot-down{color:#e74c3c}
.dot-grey{color:#888}
.note{color:#888}
.err-text{color:#e74c3c;white-space:pre-wrap;word-break:break-word}
`.trim();

function statusLabel(status: RoleDotStatus): string {
  if (status === 'up') return 'up';
  if (status === 'down') return 'down';
  return 'rides';
}

function renderRow(row: ProviderRoleRow): string {
  const dotCls = row.status === 'up' ? 'dot-up' : row.status === 'down' ? 'dot-down' : 'dot-grey';
  const detail = row.status === 'down' && row.message
    ? `<div class="err-text">${esc(row.message)}</div>`
    : row.note
      ? `<div class="note">${esc(row.note)}</div>`
      : '';
  return `<tr>
    <td>${esc(row.role)}</td>
    <td>${esc(row.provider)}/${esc(row.model)}</td>
    <td><span class="dot ${dotCls}">&#9679;</span> ${statusLabel(row.status)}${detail}</td>
  </tr>`;
}

function renderPage(rows: ProviderRoleRow[]): string {
  const trs = rows.map(renderRow).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AstraMemory Dashboard — Providers</title>
<style>${CSS}</style>
</head>
<body>
<h1>AstraMemory Local — Providers</h1>
${renderDashboardNav('providers')}
<table>
  <thead><tr><th>Role</th><th>Provider / model</th><th>Status</th></tr></thead>
  <tbody>${trs}</tbody>
</table>
</body>
</html>`;
}

export function dashboardProvidersRoute(config: Config, token: string, healthState?: HealthState, devNoAuthActive = false) {
  return async (app: FastifyInstance) => {
    app.get('/dashboard/providers', async (req, reply) => {
      const authResult = checkDashboardAuth(req, token, devNoAuthActive);
      if (!authResult.allowed) {
        return reply
          .code(authResult.status)
          .header('content-type', 'text/plain; charset=utf-8')
          .send(authResult.body);
      }

      const rows = resolveProviderRows(config, healthState);

      return reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(renderPage(rows));
    });
  };
}
