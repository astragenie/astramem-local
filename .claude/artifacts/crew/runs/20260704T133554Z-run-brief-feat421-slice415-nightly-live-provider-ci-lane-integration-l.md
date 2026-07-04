---
feature: FEAT-421
status: active
---
# Run Brief: FEAT421 SLICE415: Nightly live-provider CI lane (INTEGRATION_LIVE=ollama)

- Created: 2026-07-04T13:35:54.393Z
- Tier: full
- Goal: Wire the EXISTING INTEGRATION_LIVE=ollama gated tests into an automatic nightly GitHub Actions lane so real-Ollama drift (model renames, API changes, embed-dim changes like the 768-vs-1024 incident behind hotfix v0.2.1) is caught pre-release instead of by users. Wiring only — zero new test authorship.
- Mode: autonomous
- Pace: unattended
- Owner: loop
- Status: active
- Summary: -
- Scope:
  - - `.github/workflows/nightly-live.yml`: `schedule` (nightly cron) +
  `workflow_dispatch`; NEVER triggered by push/pull_request. Installs/starts
  Ollama (prefer the existing self-hosted linux runners if Ollama is viable
  there — they already have baked toolchains per devops#64 — else GH-hosted
  with model-blob caching)
  - pulls `mxbai-embed-large` (+ small default LLM if
  the live tests need chat)
  - runs the INTEGRATION_LIVE=ollama test subset +
  smoke suite. Target ≤15 min warm.
- Model cache keyed on model name/digest so version bumps invalidate
  automatically; cold-start time documented in the workflow README.
- Red run auto-opens or updates a single pinned issue titled
  "nightly-live: red" listing failing test names (gh CLI or
  actions/github-script); green run closes/comments it.
- Out Of Scope:
  - - Any change to PR/push CI (merges must never depend on Ollama availability).
- New live tests (existing INTEGRATION_LIVE gating only).
- Provisioning new runner infrastructure.
- Planned Files: -
- Next Step: Begin implementation

