# ADR-014: Local Fusion-Model Governance — Component Ceiling + Eval-Evidence Gate

**Status:** Accepted (operator authority delegated for this wave, FEAT-428)
**Date:** 2026-07-12 · **Confidence:** High on the mechanism (already implemented and tested);
Medium on the exact ceiling number N (a judgment call, not a derived constant)
**Context:** ADR-005 mandated a discipline for the *cloud* retrieval engine — "turn the
cross-encoder rerank ON before adding any new fusion signal" — but never stated the equivalent
rule for the *local* engine's additive `fuseScores` model (`src/search/fuse.ts`). FEAT-426's
architecture review (`.claude/artifacts/crew/reviews/20260705T134052Z-review-result-feat-426-agent-soft-boost-review.md`,
findings 1 + 3) flagged the gap after η (agent-match soft-boost) became the **third** optional
additive term stacked on the base 4-signal model (BM25 α / cosine β / importance γ / freshness δ),
joining ε (usefulness, ADR-010) and ζ (entity bonus, FEAT-402). Two problems, neither closed by
ADR-005: no stated ceiling on how many such terms the model tolerates before a learned/weighted
combiner is required, and no requirement that a nonzero weight be backed by eval evidence before
it ships.

## Decision

### 1. Component ceiling: **N = 3** optional additive terms, ceiling already reached

The local engine's fusion formula is a **base + optional-bonus** structure, not a flat N-signal
model:

- **Base (required, structural):** α·BM25 + β·cosine + γ·importance + δ·freshness — two retrieval
  channels plus two priors, tuned once and stable since ADR-002/ADR-005.
- **Optional additive bonuses (governed by this ADR):** ε (usefulness) + ζ (entity bonus) +
  η (agent bonus) — each independently toggled by a single weight, each proven (by
  `tests/search/fuse.test.ts`) to dilute every other active term's effective share of the
  normalized score.

**Ruling: 3 is the ceiling for the optional-bonus category.** A fourth optional additive term
must not be added to `fuseScores` under the current model — it requires migrating the optional
bonuses (not necessarily the base 4) to a learned/weighted combiner (e.g., a small logistic
regression or listwise model consuming per-signal features) instead of another hand-tuned
`+ θ·something`.

Rationale for stopping at 3, not 4 or 5:
- **Combinatorial tunability.** Each additive term interacts multiplicatively with every other
  active term through the shared `weightSum` normalization (`fuse.ts` module doc). At 3 optional
  terms plus 4 base terms, manually reasoning about "what does turning on ζ *and* η together do to
  ε's effective share" is already at the edge of what a human can hold in their head and validate
  one A/B delta at a time. A 4th multiplies the interaction surface again.
- **Zero terms are currently evidenced.** Per FEAT-428's own triage notes, none of ε/ζ/η has an
  eval delta on record showing it *helps* recall/NDCG (ε ships nonzero by convention/default, not
  because a delta was measured — see the exemption note below). Adding a 4th knob before validating
  the 3 that already exist compounds unvalidated ranking risk rather than resolving it.
- **Symmetry with the cloud ruling.** ADR-005's cloud rule is "no new fusion signal until the
  paid-for reranker is turned on and evidenced." The local equivalent this ADR sets: "no 4th
  optional bonus term until the existing 3 are each turned on and evidenced (or explicitly
  retired) under a learned combiner instead of more additive terms."
- **This is a policy ceiling, not a mechanical limit.** Nothing in `fuse.ts` enforces "3" as a
  count today (there is no `MAX_OPTIONAL_TERMS` constant) — the ceiling is enforced by this ADR's
  review requirement: a PR proposing a 4th additive weight must cite this document and either (a)
  get it superseded with a revised rationale, or (b) implement a learned combiner instead.

### 2. Eval-evidence rule: no shipped nonzero weight without a passing ADR-005-harness delta

**Rule:** no shipped/default config may set any optional-bonus fusion weight (ζ or η today; any
future optional term) to a nonzero value unless a passing `tests/eval/retrieval-eval.test.ts`
(ADR-005 harness) run — recall@10 and NDCG@10 both at or above the existing regression floors,
measured with the component active versus the component at 0 — is recorded and referenced in the
change.

**ε (usefulness) is the one exempt component**, not because it's special-cased loosely but because
it already clears the bar structurally: `defaultConfig().search.epsilon = 0.1` is exercised by
*every* `retrieval-eval.test.ts` run (it's the shipped default the harness's floors are measured
against), so its "evidence" is the harness's own continuous green state, not a one-time recorded
delta. ζ and η ship at 0 (inert) precisely because neither has that same continuous backing yet.

### 3. Enforcement mechanism (already implemented — FEAT-428 code, commit `188c586` + `a1ca46b`)

This governance is **not new policy awaiting a gate** — the enforceable mechanism landed on `main`
ahead of this ADR (PR #104, "fusion-model governance — component ceiling + eta eval-gate") and this
ADR formalizes, names, and extends it:

| Layer | Mechanism | File |
|---|---|---|
| Component ceiling | `applyFusionGovernance()` clamps any configured weight (α through η) above `search.governance.maxComponentWeight` (default 1.0) and logs why. Runs once at config-load time — every caller of `config.search` sees governed values, no separate call site to remember. | `src/config/config.ts` |
| Real boot path wiring | `loadConfigFromDisk` (the function `serve.ts` actually calls via `resolveRuntimeConfig`) is a thin wrapper that runs its result through `applyFusionGovernance` before returning — closes the gap where a hand-edited `config.yaml` could bypass the guard. | `src/config/loader.ts` |
| η eval-evidence gate | A configured `eta > 0` is checked against `hasPassingEvalEvidence('eta')`; with no recorded passing entry, `eta` is forced back to 0 (never a throw — matches this config layer's "never block boot" philosophy) and a warning is logged. | `src/config/config.ts` (`applyFusionGovernance`), `src/eval/eval-evidence.ts` |
| Checked-in evidence manifest (the "allowlist") | `RECORDED_EVAL_EVIDENCE: FusionEvalEvidence[]` — a reviewed, checked-in array of `{component, recordedAt, meanRecall, meanNdcg, evidenceRef}` entries. Empty today. Adding an entry (with `meanRecall >= 0.9` and `meanNdcg >= 0.7`, this repo's existing ADR-005 floors) is how a future PR licenses a nonzero weight — `evidenceRef` is a free-text pointer (PR #, artifact path, commit) to the actual harness run for audit. | `src/eval/eval-evidence.ts` |
| CI-enforceable tests | `tests/config/config.test.ts` (`describe('applyFusionGovernance')`), `tests/config/loader.test.ts`, `tests/eval/eval-evidence.test.ts` exercise the clamp, the eta gate (both injected and real evidence lookup), and the evidence-table logic in isolation. All run in the normal `bun run test` / `vitest run` suite — no separate CI job required. | `tests/config/*.test.ts`, `tests/eval/eval-evidence.test.ts` |
| **New (this ADR): shipped-default direct assertion** | `fusion-governance-shipped-config.test.ts` asserts directly against `defaultConfig().search` and the evidence manifest — independent of whether `applyFusionGovernance`'s runtime gate has been extended to a given component. This is the literal "every shipped/default config keeps its optional weights at 0 unless the manifest licenses them" check, and it is what currently catches the ζ gap noted below (the runtime gate does not). | `tests/config/fusion-governance-shipped-config.test.ts` |

**Known gap, flagged not silently carried:** `GatedFusionComponent` (`src/eval/eval-evidence.ts`)
is typed as `'eta'` only today. `applyFusionGovernance`'s runtime clamp still catches a *runaway*
ζ value (anything above the component ceiling), but a ζ value between 0 and the ceiling would pass
the runtime gate ungated — only the new shipped-config test in the table above currently defends
against that for the *shipped default*, and only for the default, not for arbitrary operator
`config.yaml` overrides. **Follow-up recommendation:** a future slice should widen
`GatedFusionComponent` to `'zeta' | 'eta'` (and update `applyFusionGovernance` to check both) so
the runtime gate — which governs every config, not just the shipped default — has the same
coverage this ADR's rule states. Filed as a fast-follow, not a blocker for this ADR's Accepted
status, since ζ ships at 0 today and no live path can currently set it otherwise.

## Options considered

1. **This ADR: ceiling at 3 optional terms + evidence-manifest gate on top of the already-shipped
   `applyFusionGovernance`/`eval-evidence.ts` mechanism (chosen).** Names and closes the governance
   gap the FEAT-426 review found, without re-deriving a mechanism that already exists, is tested,
   and is wired into the real boot path.
2. **No ceiling — evidence-gate only.** Rejected: leaves "how many is too many" unanswered, and the
   FEAT-426 review's finding 1 (component ceiling) would remain formally open.
3. **Hard ceiling enforced as a `MAX_OPTIONAL_TERMS` runtime constant/assertion in `fuse.ts`.**
   Rejected for this ADR's scope: `fuse.ts`'s own doc comment states its functions are pure and
   trust the weights they're given, with governance living upstream at config-load time by design
   (see that file's FEAT-428 paragraph) — adding a structural arity check inside `fuse.ts` would
   duplicate that boundary and was explicitly out of scope for this ADR (docs + gate-test only, no
   `fuse.ts` logic changes). The ceiling is enforced by review discipline (this document) plus the
   config-level weight-ceiling clamp, not by a hardcoded term count.
4. **Migrate ε/ζ/η to a learned combiner now, pre-emptively.** Rejected: no term has evidence yet
   that it helps at all; building a learned combiner before knowing whether the inputs are useful
   is solving the wrong problem first. Revisit only when a 4th optional term is proposed (this
   ADR's ceiling trigger) or when ε/ζ/η collectively accumulate enough usage data to make a learned
   weighting concretely better than convex combination.

## Consequences & migration

- No code or ranking-behavior change from this ADR itself — `fuse.ts` is untouched, and the
  enforcement mechanism it documents was already live on `main` before this ADR merged.
- Any future PR proposing a 4th optional additive fusion term must cite this ADR and either get it
  superseded with revised rationale, or implement a learned/weighted combiner instead of another
  `+ θ·signal` term.
- Any future PR setting `search.zeta` or `search.eta` nonzero in a shipped/default config must add
  a passing entry to `RECORDED_EVAL_EVIDENCE` (`src/eval/eval-evidence.ts`) referencing the actual
  `retrieval-eval.test.ts` run, and update `tests/config/fusion-governance-shipped-config.test.ts`
  accordingly — that test fails the build otherwise.
- Fast-follow (non-blocking): extend `GatedFusionComponent` to cover `zeta` so the *runtime*
  gate (not just the shipped-default test) protects arbitrary operator config overrides the same
  way it already protects `eta`.

## References

- ADR-005 (Retrieval — contract + shared eval harness): sets the cloud-engine discipline this ADR
  extends to the local engine, and the recall@10/NDCG@10 floors this ADR's evidence rule reuses.
- ADR-010 (Feedback & Learning Loop): source of the ε usefulness signal and its "ships nonzero by
  design, not by measured delta" exemption.
- FEAT-426 architecture review
  (`.claude/artifacts/crew/reviews/20260705T134052Z-review-result-feat-426-agent-soft-boost-review.md`),
  findings 1 (component ceiling) and 3 (no eval evidence) — the origin of this ADR.
- `src/search/fuse.ts` module doc comment — the pure-function/governance-lives-upstream boundary
  this ADR's mechanism respects.
- `src/config/config.ts` (`applyFusionGovernance`), `src/config/loader.ts`
  (`loadConfigFromDisk`), `src/eval/eval-evidence.ts` (`RECORDED_EVAL_EVIDENCE`,
  `hasPassingEvalEvidence`) — the enforcement mechanism itself (FEAT-428, PR #104).
