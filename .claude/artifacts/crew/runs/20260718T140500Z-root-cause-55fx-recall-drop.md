# Root cause — 55fx qwen recall 85 → ~70 (2026-07-18)

owner: lead; researchers: rc-artifacts (atom forensics), rc-codediff (code diff), rc-judge (judge-side)
question: qwen2.5:7b 55-fixture extraction-bench recall dropped 85±2 (rebaseline, 02:38Z,
sha 216f4932) to 68-72 (clerk legs, 10:57Z/12:26Z). Why?

## Established facts (all three tracks agree)

- **Same corpus**: fixtureSetHash 8309d60a... identical between rebaseline and today's
  legs (rc-judge's stale-43fx-corpus theory refuted by hash — they missed
  scratchpad/xbench-rebaseline/).
- **Judge exonerated**: identical config (gpt-5-mini, effort low), self-agreement
  stdev ≈ 0 on resampled fixtures, and recall tracked extractedCount in lockstep on
  every dropping fixture — no fixture shows flat atoms with falling recall.
- **Extraction volume is the whole story**: 326 atoms (rebaseline) → 328
  (gatekeeper-dry, sha af904d56 — proves FEAT-547/548 code did NOT cut volume) →
  221 (repair-only leg) → 174 (keep/junk leg).

## Attribution ladder

| step | atoms | cause |
|---|---|---|
| 326 → 221 (−105, −32%) | repair-only leg has ZERO discard authority → this loss belongs to the 552-A sweeper-prompt restructure + pass-B tuning (skip-gate sweepOnlyBelowAtoms=8, sweeper maxTokens 1500, numCtxCap 8192) landed between af904d56 and the legs | 
| 221 → 174 (−47, further) | ministral keep/junk discard verdict — and it discards junk-preferentially (junk rate 21→9), costing only ~2-4 recall pts incremental |

rc-codediff ranked the −105 candidates: (1) skip-chunk gate — a ministral-measured
speed lever silently applied to qwen's self-sweep via inherited defaults, (2) sweeper
maxTokens 1500 vs 6000 (another ministral-tuned transplant), (3) numCtxCap 8192
input-clip risk, (4) dup-key detector now drops previously-kept collapsed atoms,
(5) behavioral: new "ATOMS WITHOUT EVIDENCE ARE DISCARDED" prompt wording may make
qwen self-censor even though the code gate is OFF for same-provider passB (the
threat is not enforced for this config — prompt says one thing, code does another).

Two same-day controls (running at write time; results to be appended to
docs/eval-runs and the clerk-ab results dir): tuned-no-triage vs untuned-no-triage
split the −105 between tuning (reversible via config) and 552-A prompt effects.

## Lessons (already partially enforced)

1. **Inherited defaults are uncontrolled variables in benches** — the LoCoMo harness
   now records 'inherited-default' explicitly and pins knobs; extraction-bench gained
   --passb-sweep untuned. Every eval leg should pin passes/tuning/prompt explicitly.
2. **Tuning measured on model A must not silently apply to model B** — the pass-B
   tuning was measured on ministral (62s/call, 1961 out-tokens) and transplanted onto
   qwen's self-sweep with zero qwen measurement. Config default choices need a
   "measured on which model?" note.
3. **A judge-verdict recall drop always needs an atom-count check first** — 30 minutes
   of forensics beat hours of speculation because extractedCount was in results.json.
4. Same-day controls, run-registry provenance, fixtureSetHash comparison: all pulled
   their weight within hours of being built.

## Verdict amendments

- FEAT-547 keep/junk NO-ENABLE: STANDS, but softened — incremental cost is ~47
  junk-skewed atoms / ~2-4 recall pts, not the −17 first attributed (that number was
  confounded with tuning).
- Repair-only mode: recall parity with same-day tuned baseline still unproven —
  awaiting the tuned control; typeAcc 55 vs rebaseline 43 stands.
- Pass-B tuning: speed win real (LoCoMo: same score, 43 fewer calls) but its recall
  cost on the ENGINEERING bench was never measured before shipping — the untuned
  control prices it now. Decision after data: raise threshold/cap, or leave tuned
  defaults for clerk configs only and untuned for author-quality configs.
