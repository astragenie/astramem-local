/**
 * `retrieved-multiscope` — a Zep-style multi-scope retrieval prototype
 * (2026-07-20 "try 2"). The oracle showed the real pipeline (`retrieved-atoms`)
 * leaves ~0.18 overall / ~0.20 single-hop headroom to the perfect-evidence
 * ceiling, and Zep's edge partly comes from surfacing NEIGHBORS of the top
 * hits rather than just the top-k direct matches. This source approximates
 * that with the endpoints the eval daemon actually exposes (only `POST
 * /recall` — no entity/session-scoped search), via pseudo-relevance-feedback
 * expansion:
 *
 *   scope 1 (direct)   : recall(question, k)                 — the current pipeline
 *   scope 2 (neighbors): for each of the top EXPAND_TOP hits, recall(hit.text, EXPAND_K)
 *                        — pulls atoms semantically adjacent to what the query
 *                          already surfaced (a fact's supporting/neighboring facts)
 *
 * All hits are unioned, deduped by id (max score kept), sorted by score, and
 * capped at CAP so the answerer isn't flooded. Comparing this cell to
 * `retrieved-atoms` (same reader + judge) measures whether the single-hop
 * retrieval headroom is a RANK/RECALL problem (right atoms exist just below
 * the top-k, and neighbor expansion surfaces them) vs a store-content problem
 * (the atoms aren't there at all).
 *
 * `needsStore: true` — mounts the same daemon as `retrieved-atoms`.
 * `EvidenceSource.id` MUST equal the filename stem — `retrieved-multiscope`.
 */
import type { EvidenceSource, EvidenceContext, QA } from '../harness.mts';
import type { SearchHit, DaemonClientOpts } from '../../../shared/daemon-client.js';
import { recall } from '../../../shared/daemon-client.js';
import { projectIdFor } from '../../lib/envelope.js';

const EXPAND_TOP = (() => { const n = Number(process.env.ASTRA_LOCOMO_MS_EXPAND_TOP); return Number.isFinite(n) && n > 0 ? n : 3; })();
const EXPAND_K = (() => { const n = Number(process.env.ASTRA_LOCOMO_MS_EXPAND_K); return Number.isFinite(n) && n > 0 ? n : 8; })();
const CAP = (() => { const n = Number(process.env.ASTRA_LOCOMO_MS_CAP); return Number.isFinite(n) && n > 0 ? n : 30; })();

const retrievedMultiscope: EvidenceSource = {
  id: 'retrieved-multiscope',
  needsStore: true,
  async hitsFor(qa: QA, sampleId: string, ctx: EvidenceContext): Promise<SearchHit[]> {
    const client = ctx.daemonClient as DaemonClientOpts | undefined;
    if (!client) throw new Error('retrieved-multiscope needs a mounted store (ctx.daemonClient is undefined)');
    const filters = { project: projectIdFor(sampleId) };

    // scope 1 — direct query (identical to retrieved-atoms)
    const primary = await recall(client, { text: qa.question, limit: ctx.k, filters });

    // scope 2 — neighbor expansion: re-recall seeded by the top hits' own text
    const seeds = primary.slice(0, EXPAND_TOP);
    const expansions = await Promise.all(
      seeds.map(h => recall(client, { text: h.text, limit: EXPAND_K, filters }).catch(() => [] as SearchHit[])),
    );

    // union, dedupe by id (keep the highest score seen for each), rank, cap
    const best = new Map<string, SearchHit>();
    for (const h of [primary, ...expansions].flat()) {
      const prev = best.get(h.id);
      if (!prev || h.score > prev.score) best.set(h.id, h);
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, CAP);
  },
};

export default retrievedMultiscope;
