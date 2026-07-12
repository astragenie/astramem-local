---
id: PM-REVIEW-FEAT-474
feature: FEAT-474
reviewed_at: 2026-07-12
pm_customer_impact: 0.3
pm_effort_estimate: 0.6
pm_strategic_alignment: 0.4
pm_technical_risk: 0.45
pm_dependency_depth: 0.2
composite_priority: P2
autonomous_safe: false
---
# PM Review — FEAT-474

## Demand Assessment

- **Evidence:** No direct end-user complaint or stakeholder quote. Evidence is internal/investigative: derived_from FEAT-447's investigation into Supermemory's install.sh (333 lines, fetched verbatim per the FEAT body), which found installer-hygiene patterns 'cheap to copy' independent of the single-binary question FEAT-447 was actually chartered to answer. The FEAT body itself names one plausible recurring friction class rather than a reported incident: PATH guidance is framed as 'same problem class as our npm-global-bin PATH friction' — a class-level analogy, not a quoted user complaint. I grepped .claude/artifacts/loop/learnings.jsonl for onboarding/installer/PATH/checksum/manifest terms and found zero matches — no lesson or grade ties an actual failure to this domain. Per the demand-assessment rule (no evidence -> customer_impact <= 0.3), scored at 0.30.

## Scope Challenge

- **Scope notes:** Smallest deliverable: the FEAT is a 9-pattern checklist (checksum manifest, idempotent skip-if-current-version, /dev/tty reattach, env-var prefill, non-interactive escape hatches, PATH guidance, secure file perms, root/sudo handling, version-resolution strategy) mapped onto init.ts plus a new install.sh/install.ps1 wrapper. If halved, I would keep only the wizard-side patterns (env-var prefill, non-interactive flags, PATH guidance) and defer the new install.sh/install.ps1 wrapper entirely (checksum manifest, /dev/tty reattach, root/sudo handling, version-resolution) to a follow-up, since the wrapper doesn't exist today and is the larger net-new surface. Overlap check (the FEAT body itself asks for this): I read src/cli/init.ts:10,763-785 directly — secrets.env is ALREADY written at mode 0600 ('secrets.env ALWAYS ... mode 0600'), so the 'secure file perms' pattern is largely already enforced for the one file that matters most, not merely documented as the FEAT body assumes; scope for that sub-pattern narrows to auditing install-dir perms more broadly. I also read src/cli/reinstall.ts:289,495 — reinstall already asserts `body.version === releaseManifest.pkgversion` post-install (served-version-matches-build assertion), which is adjacent to but not the same as Supermemory's pre-install 'skip if already current + FORCE=1 override' idempotency pattern; the two should be reconciled rather than duplicated, exactly as the FEAT body itself warns. Effort calibration (Framework 5): no cost-report analog exists for installer-UX-checklist work specifically; nearest structural analog is FEAT-443's decomposed 8-point cross-platform service-parity FEAT (systemd/launchd port, cost-report-confirmed ~$127 combined for the Windows-side analog alone per that FEAT's own PM review) — FEAT-474 touches fewer platforms but a wider pattern checklist (9 distinct behaviors vs FEAT-443's 2), landing at a comparable effort_estimate of 0.60 rather than higher or lower; noting 'no direct cost analog' per Framework 5 since nothing in .claude/artifacts/crew/cost/ touches install.sh/wizard UX. Weak grade dimensions (loop-snapshot.md, last-5-grade averages): architecture_quality 0.53, observability 0.68, production_readiness 0.53, security 0.52, product_completeness 0.55 (all below 0.80; reliability 0.88 and test_confidence 0.878 are healthy). security is directly relevant here (chmod 600 enforcement, checksum verification, sudo/root handling are all security-adjacent installer behaviors) and production_readiness is directly relevant (install robustness) — a future slice's AC must include a security-facing criterion (e.g., an automated check that installed secrets/config files actually have restrictive perms, not just a code comment claiming it) given security is a named weak dimension. AC clarity: the FEAT body is a mapped checklist with soft language ('map the following patterns onto...', 'check for overlap/reuse before adding') rather than concrete Given-When-Then criteria or a quantified acceptance bar (contrast with FEAT-475's explicit '5 consecutive green runs' bar) — this is vague-scope by the AC-clarity checklist, driving autonomous_safe=false independent of the decomposition gate. Non-goals are clear and correctly reinforce FEAT-445's defer verdict (no single-binary work), which I did not re-litigate.

## Scores

- customer_impact: 0.30
- effort_estimate: 0.60
- strategic_alignment: 0.40
- technical_risk: 0.45
- dependency_depth: 0.20

## Priority Derivation

composite_priority: P2
autonomous_safe: false
reasoning: P2 via formula: impact 0.30 < 0.70 and alignment 0.40 < 0.80, so neither P1 branch fires; effort 0.60 < 0.70 so the P3 branch (effort>=0.70 AND impact<=0.30) does not fire either despite impact qualifying — lands P2 by the formula's default branch. composite_score=0.105+0.12+0.08+0.055+0.04=0.40. technical_risk banded at 0.45 (mid 0.3-0.5 band: 'new pattern in repo... no contract change, clean rollback') — a new install.sh/install.ps1 wrapper is a new pattern for this repo and touches multiple files (wizard + 2 new scripts + release-CI manifest publish step), but there is no schema/runtime contract change and every sub-pattern is independently, cleanly revertible via git revert. pm_effort_points=8 (band [0.6,0.85) per this repo's established PM convention, confirmed against FEAT-443/446's own stated bands) — this TRIPS the FEAT-168 decomposition gate. I am supplying proposed_slices below (option 1) rather than needs-review, since the 9-pattern checklist decomposes cleanly along wizard-vs-wrapper-vs-release-pipeline boundaries with no cross-repo or unclear-scope blocker. autonomous_safe=false: forced both by the missing-AC/vague-scope finding above and by not having drafted ACs (P2, no --deep/--spec flag passed).

## Risks

- Scope-creep risk: 9 independent hygiene patterns invite silent scope growth if a builder tries to ship all of them in one pass instead of following the proposed slice boundaries below.
- Duplicate-mechanism risk (named directly in the FEAT body): building a parallel idempotent skip-if-current-version check without first reading reinstall.ts's existing served-version-vs-build-version assertion (src/cli/reinstall.ts:289,495) risks two divergent 'is this already installed' mechanisms that can disagree.
- Platform-asymmetry risk: install.sh (bash) and install.ps1 (PowerShell) are two independent implementations of the same pattern list — a fix or pattern added to one is easy to forget porting to the other, silently reintroducing exactly the kind of Windows/Unix asymmetry CLAUDE.md already documents elsewhere in this repo (service parity).
