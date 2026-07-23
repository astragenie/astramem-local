---
findings: "🔴:0,🟡:0,❓:1"
status: completed
decision: approved
author_id: w3-doctor (worktree agent)
judge_id: reviewer (independent, dispatched by team-lead)
self_approval: false
---
# Review Result: W3-doctor governance+scheduling

- Created: 2026-07-23T16:39:26Z
- Updated: 2026-07-23T (diff-base correction) — team-lead flagged that the
  correct merge-base for this branch is `3443efb1`, not the current
  `feat/retrieval-overhaul` tip (a `w4/eval` merge landed on `feat/retrieval-
  overhaul` after `w3/doctor` branched off). Re-ran `git diff
  3443efb1..w3/doctor --stat`: exactly the 8 files below, zero LoCoMo
  eval-script noise. This confirms — rather than merely asserts — the
  original ❓ about stale-base diff noise; it is fully resolved, not just
  low-risk, and is removed from the risk list below.
- Reviewer: reviewer (independent)
- Decision: approved
- Status: completed
- Summary: PASS. Branch `w3/doctor` (commits `a07b2e9c` wire hardening+GPU
  checks into unattended schedule, `9184d952` unify loadConfig/loadConfigFromDisk
  governance) is safe to merge. Both changes are exactly what their own doc
  comments claim: (1) the 9 previously-CLI-only doctor checks are now routed
  to the frequent/full tier strictly by each check's own pre-existing `tier`
  field, with both directions (cheap checks reach frequent tier; full checks
  are excluded from frequent tier) locked by regression tests; (2)
  `applyAllGovernance` is a genuine behavior-preserving unification that
  additionally fixes 3 real, previously-undetected governance gaps (audio had
  ZERO governance on the real boot path; extractionPasses ungoverned on disk;
  atomTriage ungoverned in-process) without dropping or reordering any of the
  17 composed governance calls.
- Evidence Checked:
  - `git diff 3443efb1..w3/doctor -- src/doctor/schedule.ts src/doctor/hardening-checks.ts src/doctor/gpu-checks.ts src/config/config.ts src/config/loader.ts` (correct merge-base, per team-lead correction) — read in full. `git diff 3443efb1..w3/doctor --stat` confirms the branch's real surface is exactly the 8 files listed below — no LoCoMo eval-script files appear against the correct base.
  - Confirmed `extraChecks()` (schedule.ts) reuses `coreChecks()`'s own default resolution (`port ?? 7777`, `dataDir ?? join(tmpdir(),'astramem')`, `encryptionEnabled ?? true` — checks/index.ts:179-183) and `openProductionDbReadonly(join(dataDir,'memory.sqlite'), encryptionEnabled)` matches every other check file's call convention (grepped all 20+ call sites under src/doctor/checks/*.ts).
  - Confirmed no double-registration risk: `getChecks()` never includes hardening/gpu checks itself; `cli/doctor.ts` and `schedule.ts` both concatenate them externally via the identical pattern.
  - Traced all 7 governance functions composed for `distill` and all 3 for `consolidation` against their individual signatures (`Config['distill'] -> Config['distill']`, etc.) — each touches only its own subfield and passes the rest through untouched, so the claimed order-independence is real, not asserted.
  - Diffed old `loadConfig` (6 distill fns, missing AtomTriage) vs old `loadConfigFromDisk` (6 distill fns, missing ExtractionPasses; audio absent entirely) vs new `applyAllGovernance` (7 distill fns = union; audio always present) — the three claimed fixes are real and are the only behavior deltas.
  - Ran `npx vitest run tests/config` live: 324/324 passed (18 files), including the new `governance-chain-parity.test.ts`, which genuinely asserts `loadConfigFromDisk`/`loadConfig` agree on 4 different invalid-input fields via a real disk round-trip, not just a mocked comparison.
  - Ran `npx vitest run tests/doctor` live: 412/412 passed (53 files) in 27.5s — combined 736, matches the review brief's expectation exactly.
  - Ran `npx tsc --noEmit -p tsconfig.json` and `-p tsconfig.tests.json` live: both 0 errors.
  - Confirmed `git status --short` against the reviewed files in the main checkout `C:/work/mega/astramem-local` is empty (base discipline intact).
- Files Reviewed:
  - src/doctor/schedule.ts
  - src/doctor/hardening-checks.ts
  - src/doctor/gpu-checks.ts
  - src/config/config.ts
  - src/config/loader.ts
  - tests/doctor/schedule.test.ts
  - tests/doctor/schedule-interval.test.ts
  - tests/config/governance-chain-parity.test.ts (new)
- Test Adequacy: Both review-focus items 1 and 2 are locked by regression tests, not just documented. `FULL_TIER_ONLY_CHECK_NAMES` (schedule.test.ts) now includes both new full-tier names ("Orphaned llama-server processes", "Silent CPU offload") — the negative direction. A new `CHEAP_EXTRA_CHECK_NAMES` test (added by this PR) asserts the positive direction: all 6 hardening checks + "Ollama tuning env vars" actually reach `runFrequentDoctorChecks`'s output, not just stay absent from the full-tier-only list by omission — closing exactly the gap a reviewer would otherwise have to take on faith. `governance-chain-parity.test.ts` locks both concrete fixes (extractionPasses-on-disk, audio.mode-on-disk) via `loadConfigFromDisk` directly (mirroring the existing atom-triage/gatekeeper boot-governance test pattern) plus a 4-field parity sweep proving both paths land on identical governed output from the same dirty config.
  Spot-checked the "not masking a hang" question (review focus 3) by reading the actual bounds: `gpu-vram-probe.ts`'s native subprocess calls are capped at `NATIVE_CMD_TIMEOUT_MS = 5_000`, the Ollama `/api/ps` fetch at `AbortSignal.timeout(3_000)`, and `runChecks()` awaits one check at a time — worst case for the two new full-tier checks is bounded (~2x5s + 3s plus the rest of the full registry), so the 20s per-test timeout bump is a real worst-case allowance under CI/parallel-load contention, not a mask for an actual hang; independently reproduced this by running the suite and observing all full-tier tests complete well within budget. The `vi.mock` additions in schedule-interval.test.ts are necessary for the same reason documented in its own header: `getGpuChecks()`'s real `readPersistedEnvVars` is a PowerShell child-process spawn, genuine async I/O that fake timers cannot fast-forward through.
- Author: builder (w3/doctor branch, worktree w3-doctor)
- Judge: reviewer (independent)
- Risks:
  - ❓ [LOW, pre-existing, out of this diff's scope] `src/cli/serve.ts`'s `baseDoctorOpts`/`fullDoctorOpts` (unchanged by this PR) never populates `DoctorCheckOpts.ollamaBaseUrl`, unlike `cli/doctor.ts`'s manual run which explicitly passes `cfg.ollama.baseUrl`. This means the newly-scheduled GPU checks (and the pre-existing `checkModelFitCanary` in the core registry, which had the identical blind spot before this PR) always probe the hardcoded default `http://127.0.0.1:11434` on the unattended path, regardless of a non-default configured Ollama URL. Degrades gracefully (reports `inconclusive`, never a false RED), so not a correctness bug, but worth a fast-follow in serve.ts since it's the one remaining place `extraChecks()`'s "identical behavior to the CLI doctor path" claim doesn't quite hold. Flagging for awareness, not a blocker for this PR (serve.ts is untouched by this diff).
- Required Follow-up: None required to merge. One optional fast-follow noted above (thread `cfg.ollama.baseUrl` into serve.ts's `baseDoctorOpts` for full CLI/scheduled parity). The previously-flagged diff-base noise is resolved, not just low-risk — confirmed zero LoCoMo files in the branch's real diff against its actual merge-base.
