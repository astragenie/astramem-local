---
id: FEAT-415
status: done
completed: 2026-07-04
priority: P1
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: []
derived_from: arch-review-2026-07-04
pm_customer_impact: 0.80
pm_effort_estimate: 0.55
pm_strategic_alignment: 0.70
pm_technical_risk: 0.60
pm_dependency_depth: 0.35
pm_effort_points: 5
composite_score: 0.63
composite_priority: P1
autonomous_safe: false
pm_demand_evidence: "encryption.enabled:true is the production default, yet the encrypted restart path (better-sqlite3-multiple-ciphers + keystore fallback) has ZERO automated coverage — accepted as F1 tradeoff in SLICE-SMOKE-1 specifically to avoid touching the real OS credential store."
pm_scope_notes: "Smallest deliverable: a test-only seam (forced key-file fallback via config/env) that never touches the real credential store — do not expand into a general keystore refactor. No production behavior change."
pm_risks:
  - "Pre-mortem (technical_risk 0.60): a test-only seam accidentally becomes reachable in production config, silently weakening real encryption-key handling. Mitigation: seam config/env-gated with a test asserting production defaults unaffected."
  - "Test infra itself touches the real Windows Credential Manager despite intent (as F1 already flagged for the unencrypted case) — must be verified, not assumed."
  - "If wrong-key restart doesn't already fail loud, this FEAT could surface a second, unrelated bug mid-implementation — scope creep risk."
reasoning: "Highest-severity untested gap in the batch — silent data inaccessibility on restart is the worst failure for a local-first ENCRYPTED daemon, and encryption is on by default. autonomous_safe=false because it touches keystore/encryption code."
---
# FEAT-415: Smoke coverage for the encrypted-DB restart path

## Problem
SLICE-SMOKE-1 restart persistence runs with security.encryption.enabled: false (accepted F1 tradeoff — enabling it would touch the real OS credential store from tests). The product's core promise is a local-first ENCRYPTED daemon, and the encrypted reopen path (better-sqlite3-multiple-ciphers + keystore/key-file fallback) has zero automated restart coverage. Failure class: silent data inaccessibility surfacing weeks later on a real user's restart.

## Acceptance (PM GWT)
1. Given security.encryption.enabled:true (production default) and a fresh datadir, When the daemon ingests data, is SIGKILLed, and restarts against the same encrypted datadir, Then all data (memory counts, ids) is identical pre/post-restart.
2. Given the test needs a decryption key, When it runs in CI/sandbox, Then it uses a test-reachable key path (forced key-file fallback) that never touches the real OS credential store.
3. Given the daemon restarts with the WRONG key against an encrypted datadir, When it attempts to open the database, Then it fails loud with an actionable error (not silent data loss or a generic crash).
4. Given the new test seam is added, When production encryption code paths run outside tests, Then there is no behavior change (seam is test-only/config-gated).
5. Given technical_risk on this FEAT is >=0.6, When the builder scopes implementation, Then a pre-mortem is completed identifying the smallest-blast-radius seam before any keystore code is touched.

## Evidence
Run artifact F1 accepted-limitation note; architecture review debt rank 2.


## Resolution (2026-07-04, Wave A)
Encrypted restart smoke merged 7bb804b. ASTRA_MEMORY_TEST_FORCE_KEYFILE seam (warn-logged), wrong-key SQLITE_NOTADB rewrap in serve.ts, PLUS pre-existing bug fixed: SLICE-SMOKE-1 daemons silently ran encryption-ON against real credential store (config.yaml path bug in daemon.ts helper). Review PASS after warn-log fix. Follow-up noted: tests/smoke ~1-in-10 flake under repeated concurrent runs (pre-existing class).

