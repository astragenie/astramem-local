/**
 * FEAT-428: recorded eval evidence for the η (eta) fusion component.
 *
 * Arch-review of FEAT-426 (agent soft-boost) flagged two governance gaps in
 * the local fusion model (src/search/fuse.ts): no ceiling on how large any
 * single additive component weight may be, and no eval evidence that any
 * nonzero optional weight actually helps ranking. This module closes the
 * second gap for η specifically (the newest, least-validated term): before a
 * loaded config may activate `search.eta > 0`, a passing ADR-005 harness run
 * (tests/eval/retrieval-eval.test.ts) comparing eta active vs eta=0 must be
 * recorded here — see `applyFusionGovernance` in src/config/config.ts, the
 * call site that enforces this at config-load time.
 *
 * Deliberately a static, reviewed table rather than a live eval run at
 * config-load time — running the harness on every `serve` boot would add
 * real startup cost for a check that only needs to happen once per config
 * change. "Evidence exists" means a human (or CI) ran the harness, saw a
 * non-regressing recall@10/NDCG@10 delta with eta active, and committed an
 * entry here — the audit trail ADR-005 already expects for the cloud engine,
 * now required of the local engine too.
 *
 * ε (usefulness) and ζ (entity bonus) are NOT gated here: ε ships nonzero by
 * default already backed by the passing ADR-005 harness (defaultConfig().search
 * epsilon=0.1 is exercised by every retrieval-eval.test.ts run), and ζ's
 * default is 0 with its own dedicated snapshot test (AC-6). η is the
 * component FEAT-428 was opened for — see FEAT-428.md.
 *
 * issue #190: `implicitPositive` was added alongside η — it gates
 * `search.usefulness.implicitPositive.enabled` (the automatic positive-
 * usefulness-signal sweep, src/storage/usefulness.ts's
 * `runImplicitPositivePass`), not a fusion weight, but follows the identical
 * "ships OFF, needs a recorded ADR-005 run before going live" posture: see
 * docs/specs/20260714-implicit-usefulness-signal-190.md.
 *
 * issue #352B: `theta` gates `search.theta` (the 8th fusion component, the
 * supersession/correction freshness bonus — see src/search/fuse.ts's module
 * doc). Same "empty table, ships 0" posture as η at introduction: the
 * corrected-atom MARKER on recall payloads is available immediately
 * (src/search/search.ts's `correctionSignalForCandidates`), independent of
 * this gate — only the fusion WEIGHT is held back pending evidence.
 */

/** Fusion weight keys this module can record evidence for. 'eta', 'theta',
 * and 'implicitPositive' are currently gated (see module doc); the union
 * leaves room for a future component without implying ε/ζ are gated today. */
export type GatedFusionComponent = 'eta' | 'theta' | 'implicitPositive';

export interface FusionEvalEvidence {
  /** The fusion weight key this evidence licenses. */
  component: GatedFusionComponent;
  /** ISO date the eval run was recorded. */
  recordedAt: string;
  /** mean recall@10 achieved with the component active (ADR-005 harness). */
  meanRecall: number;
  /** mean NDCG@10 achieved with the component active (ADR-005 harness). */
  meanNdcg: number;
  /** Free-text pointer to the run for audit (PR #, artifact path, commit). */
  evidenceRef: string;
}

/** ADR-005 regression floors (tests/eval/retrieval-eval.test.ts). Recorded
 * evidence must clear these floors to license activation — a recorded run
 * that itself regressed doesn't count as evidence the component is safe. */
export const RECALL_FLOOR = 0.9;
export const NDCG_FLOOR = 0.7;

/**
 * Recorded evidence table. Empty for 'eta': FEAT-426 shipped the agent
 * soft-boost with eta=0 and no eval-harness run backing a nonzero value —
 * exactly the gap FEAT-428 closes. Add an entry here (backed by a real
 * ADR-005-harness run showing eta active does not regress the floors)
 * before shipping any config with eta > 0.
 */
export const RECORDED_EVAL_EVIDENCE: FusionEvalEvidence[] = [];

/**
 * True if `RECORDED_EVAL_EVIDENCE` contains an entry for `component` that
 * clears both ADR-005 floors. Accepts an injectable evidence list (tests
 * only) so callers don't have to mutate the module-level table.
 */
export function hasPassingEvalEvidence(
  component: GatedFusionComponent,
  evidence: readonly FusionEvalEvidence[] = RECORDED_EVAL_EVIDENCE,
): boolean {
  return evidence.some(
    e => e.component === component && e.meanRecall >= RECALL_FLOOR && e.meanNdcg >= NDCG_FLOOR,
  );
}
