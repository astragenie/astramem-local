# Doctor red-check triage for 0.20 (2026-07-19)

Triaged the 5 failing doctor checks on the live 0.19.0 daemon before cutting 0.20.
**Conclusion: none is a shippable code defect. Doctor is release-acceptable.**

| Check | Class | Finding |
|---|---|---|
| Consolidation group coverage | gated | `consolidation-run.ts` correctly WARNs that `'full'` candidateSelection skipped oversized groups. The fix — flip default to `'knn'` — is **explicitly soak-gated** (config.ts:1589-1594: "Promote to 'knn' per-install only after the soak test confirms recall parity + backlog shrinks"; `maxCandidatePairsPerRun` ships null/unbounded). NOT a blind config flip. → knn-promotion soak deferred to 0.21. |
| Watchdog restart storm | operational | Dev-box rebuild/reinstall churn (≥3 kills in 6h window). Not code. |
| Event loop lag | self-cleared | Boot warm-up starved the loop once; live p99=33ms. Not code. memory-health-scan hypothesis refuted (tier:full, can't run in frequent window). |
| Budget cap vs codex-subscription | by-design | Standing WARN (FEAT-482, usd hardcoded 0). |
| Dev no-auth mode | by-design | Intentional dev-posture WARN. |

Correction on record: an earlier triage summary classified consolidation-coverage as a
"just flip the default" quick fix. That MISSED the P2.1 stabilization gate comment — the
flip requires a soak test (recall parity + 792-proposal-backlog shrinkage). Do NOT flip
`candidateSelection` to `'knn'` globally without it (re-deciding-a-gated-default class,
same as the contradiction-detection incident).

**0.21 candidate:** run the P2.1 soak (docs/research/20260717-six-item-stabilization-plan.md
§6) to safely promote knn and drain the consolidation backlog.
