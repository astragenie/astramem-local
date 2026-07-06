---
id: SLICE-415
title: Nightly live-provider CI lane (INTEGRATION_LIVE=ollama)
status: completed
feature: FEAT-421
phase: null
priority: P2
target_release: null
requires_validation: true
risk: medium
created: 2026-07-04
updated: 2026-07-04
touches_files: [.github/workflows/nightly-live.yml, .github/workflows/README.md]
completed_at: 2026-07-04
---
# SLICE-415: Nightly live-provider CI lane (INTEGRATION_LIVE=ollama)

Implements FEAT-421. See [feature file](../../../backlog/in-progress/FEAT-421.md).

## Objective

Wire the EXISTING INTEGRATION_LIVE=ollama gated tests into an automatic
nightly GitHub Actions lane so real-Ollama drift (model renames, API changes,
embed-dim changes like the 768-vs-1024 incident behind hotfix v0.2.1) is
caught pre-release instead of by users. Wiring only — zero new test authorship.

## In scope

- `.github/workflows/nightly-live.yml`: `schedule` (nightly cron) +
  `workflow_dispatch`; NEVER triggered by push/pull_request. Installs/starts
  Ollama (prefer the existing self-hosted linux runners if Ollama is viable
  there — they already have baked toolchains per devops#64 — else GH-hosted
  with model-blob caching), pulls `mxbai-embed-large` (+ small default LLM if
  the live tests need chat), runs the INTEGRATION_LIVE=ollama test subset +
  smoke suite. Target ≤15 min warm.
- Model cache keyed on model name/digest so version bumps invalidate
  automatically; cold-start time documented in the workflow README.
- Red run auto-opens or updates a single pinned issue titled
  "nightly-live: red" listing failing test names (gh CLI or
  actions/github-script); green run closes/comments it.
- `.github/workflows/README.md` updated with the new lane's purpose, triggers,
  cache behavior, and triage-owner note.

## Out of scope

- Any change to PR/push CI (merges must never depend on Ollama availability).
- New live tests (existing INTEGRATION_LIVE gating only).
- Provisioning new runner infrastructure.

## Acceptance criteria

- [ ] AC-1: Workflow triggers are exactly `schedule` + `workflow_dispatch` —
      grep-verifiable; PR CI workflows untouched by the diff.
- [ ] AC-2: A manually dispatched run on this branch reaches the live test
      step and executes the INTEGRATION_LIVE subset against a real Ollama
      (evidence: run URL + step log showing live tests executed, not skipped).
      If runner feasibility blocks a real green run, the slice STOPS and
      surfaces the evidence instead of shipping an untested workflow.
- [ ] AC-3: Failure path creates/updates the pinned issue with failing test
      names; green path closes/annotates it — logic present and exercised at
      least via a forced-failure dispatch or documented dry-run of the script
      step.
- [ ] AC-4: Model caching keyed on model identity; workflow README documents
      cold vs warm timing and the triage owner.
- [ ] AC-5: `bun run build` + full local suite stay green (no product code
      touched; CI-only diff).

## Done When

- all ACs PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- feature FEAT-421 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written

## Reviewer ladder

- Reviewer A: crew:reviewer (workflow correctness, trigger isolation)
