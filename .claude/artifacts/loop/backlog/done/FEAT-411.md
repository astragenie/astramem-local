---
id: FEAT-411
status: done
completed: 2026-07-04
priority: P1
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: []
derived_from: arch-review-2026-07-04
pm_customer_impact: 0.75
pm_effort_estimate: 0.55
pm_strategic_alignment: 0.75
pm_technical_risk: 0.55
pm_dependency_depth: 0.45
pm_effort_points: 5
composite_score: 0.63
composite_priority: P1
autonomous_safe: false
pm_demand_evidence: "SLICE-SMOKE-2 roundtrip caught a real wire-contract violation (score>1, fixed cedc8a9) on its first MANUAL run; architecture review rated the CI gap finding 3 [HIGH]."
pm_scope_notes: "Smallest deliverable is the golden-contract-fixture fallback (single-repo, no cross-repo secrets) rather than full dual-checkout CI — ship that first, live-roundtrip CI as stretch. Blast radius: two repos' CI pipelines if live-checkout path chosen."
pm_risks:
  - "Cross-repo checkout needs an access token/secret in CI — an operator decision, not purely a code change."
  - "Fork/restricted-permission CI runs must degrade to skip, not fail, or this becomes a new flakiness source."
reasoning: "Real bug, real fix already shipped — this closes the detection gap so the next regression doesn't rely on a human manually setting an env var. autonomous_safe=false only because cross-repo secrets/access is a coordination decision."
---
# FEAT-411: Wire cross-repo plugin↔daemon roundtrip into CI

## Problem
The SLICE-SMOKE-2 roundtrip test (astramemory-plugin tests/e2e/plugin-daemon-roundtrip.test.ts) caught a real wire-contract violation (fused score > 1, fixed in cedc8a9) on its FIRST manual run — but it only runs when a human sets ASTRAMEM_LOCAL_DIST_PATH to a built sibling checkout. Hermetic CI passes silently on the next cross-repo regression. Architecture review rated this the HIGH-priority follow-up: "leaving it CI-optional means the safety net worked once by luck."

## Acceptance (PM GWT)
1. Given a PR changes daemon search/recall response serialization, When CI runs, Then a job checks out both repos, builds the daemon, and runs the plugin roundtrip test with ASTRAMEM_LOCAL_DIST_PATH set.
2. Given the roundtrip test detects a wire violation (score > 1), When that CI job runs, Then it fails red and blocks merge.
3. Given the fallback golden-fixture design is chosen instead, When a daemon release is cut, Then the fixture JSON is regenerated and a plugin-repo conformance test validates against it, tradeoff documented.
4. Given no ASTRAMEM_LOCAL_DIST_PATH and no cross-repo CI job configured, When the hermetic suite runs, Then it stays green with an actionable skip.
5. Given the cross-repo job runs in a fork with no repo-access token, When it can't check out the sibling repo, Then it skips with a clear message rather than failing.

## Evidence
Run artifact .claude/artifacts/crew/runs/2026-07-04-smoke-suite-phase0-1.md — architecture review finding 3 [HIGH]. Existing contracts/ schema conformance could NOT catch this class (numeric-range, not shape).


## Resolution (2026-07-04, Wave A)
Daemon-side cross-repo-roundtrip workflow (self-hosted pool, public plugin checkout, no token) merged a884815; plugin-side secret-gated mirror committed on plugin branch feat/FEAT-411-crossrepo-ci. Review PASS after runs-on fix. Operator TODO: add required check "cross-repo-roundtrip" + create ASTRAMEM_LOCAL_TOKEN secret in astramem-plugin.

