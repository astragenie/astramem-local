/**
 * `retrieved-atoms` `EvidenceSource` — exactly what the CURRENT pipeline
 * retrieves (the store's live `/recall` search results), byte-faithful to
 * `scripts/eval/locomo/answer.mts`'s own retrieval call (same `text`, same
 * `limit: k`, same `filters: { project: projectIdFor(sampleId) }`).
 *
 * WHAT THIS MEASURES (v2 plan §Phase 1 — see `harness.mts`'s header): this
 * cell crossed against `gold-atoms` (a sibling builder's source, landing in
 * this same wave) isolates RETRIEVAL loss — the right atoms exist in the
 * store, but does `/recall` actually surface them for this question? A gap
 * between `gold-atoms` and `retrieved-atoms` scores is retrieval, not
 * extraction or answering.
 *
 * `EvidenceSource.id` MUST equal the filename stem — this file's id is
 * `retrieved-atoms`, matching `retrieved-atoms.mts`.
 */
import type { EvidenceSource } from '../harness.mts';
import { recall } from '../../../shared/daemon-client.js';
import { projectIdFor } from '../../lib/envelope.js';

const retrievedAtoms: EvidenceSource = {
  id: 'retrieved-atoms',
  needsStore: true,
  async hitsFor(qa, sampleId, ctx) {
    if (!ctx.daemonClient) {
      throw new Error(
        'retrieved-atoms: EvidenceContext.daemonClient is undefined — the harness should have mounted a ' +
          'store daemon because this source declares needsStore:true. This is a harness wiring bug, not a ' +
          'valid "no evidence" result.',
      );
    }
    // IDENTICAL to answer.mts's real retrieval call (same text, same k, same
    // project filter) — this source must be byte-faithful to the actual
    // benchmark path, not a reimplementation of it.
    return recall(ctx.daemonClient, {
      text: qa.question,
      limit: ctx.k,
      filters: { project: projectIdFor(sampleId) },
    });
  },
};

export default retrievedAtoms;
