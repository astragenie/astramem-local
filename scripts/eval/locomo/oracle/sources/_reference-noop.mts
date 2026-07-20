/**
 * Reference `EvidenceSource` — always returns zero hits.
 *
 * Two jobs: (1) prove the glob-discovery + driver + judge + aggregate path
 * end-to-end without needing a store daemon or any external evidence at
 * all, and (2) serve as the copy-paste template for the 3 parallel builders
 * landing the real sources (gold-source-turns, gold-atoms, retrieved-atoms,
 * retrieved-source-spans — see `docs/research/20260720-locomo-improvement-v2-post-crossreview.md`
 * §"Phase 1 — the oracle factorial").
 *
 * Filename starts with `_` -> still discoverable/loadable (harness.mts's
 * `discoverSources` finds it), but excluded from `defaultSelection` so an
 * ordinary `oracle-factorial.mts` invocation with no `--sources` flag never
 * silently runs it. Select it explicitly: `--sources _reference-noop`.
 *
 * `EvidenceSource.id` MUST equal the filename stem — this file's id is
 * `_reference-noop`, matching `_reference-noop.mts`.
 */
import type { EvidenceSource } from '../harness.mts';

const referenceNoop: EvidenceSource = {
  id: '_reference-noop',
  needsStore: false,
  async hitsFor() {
    return [];
  },
};

export default referenceNoop;
