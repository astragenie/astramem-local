---
id: FEAT-539
status: pending
priority: P1
category: feature
target_release: RC
created: 2026-07-17
depends_on: [FEAT-538]
derived_from: "2026-07-17 — operator request after the codex quota-limit incident; dashboard should show every pipeline's provider + green/red status"
---
# FEAT-539: Dashboard "Providers" section — every pipeline's configured provider + green/red status

## Description

Add a Providers section/page to the dashboard (`http://127.0.0.1:7777/dashboard`) showing,
for EVERY pipeline role, the configured provider + model + a live green/red health status.
Motivated by the 2026-07-17 codex quota-limit incident: the operator had no at-a-glance way
to see that the extraction provider was down — `/health` said `ok` and the dashboard had no
provider view.

## Pipeline roles to surface (each = one row)

- **embedding** (onnx / ollama / azure) — the embed provider + dim
- **compaction** (llm.compaction) — provider + model
- **extraction** (llm.extraction) — provider + model  ← the one that went down
- **judge** (consolidation.contradictionDetection) — provider + model (or "rides extraction")
- **extractionPassB** (distill.extractionPassB) — provider + model (or "rides extraction")
- **atomTriage** (distill.atomTriage) — provider + model (or "rides extraction")

For each: name, model, and a **green (up) / red (down) / grey (unconfigured/rides-parent)**
status dot, plus the failure reason + remedy on red (e.g. "codex-subscription: quota/auth —
run `codex login` or switch provider").

## Data source (hard dependency: FEAT-538)

Read the provider-health state FEAT-538 produces (`healthState.providerHealth`, surfaced via
`/health`) — do NOT add a separate per-provider probe in the dashboard (that would be a
metered self-DoS + a second source of truth that drifts from /health). Green/red mirrors
exactly what /health.status uses. Config (which provider is assigned to which role) comes
from the resolved runtime config the daemon already exposes.

## Acceptance criteria

- AC-1: The Providers section lists all 6 roles with provider + model.
- AC-2: Each role shows green/red/grey sourced from FEAT-538's providerHealth (not a new probe).
- AC-3: A red row shows the failure reason + the actionable remedy (401 vs 429 distinct).
- AC-4: Roles that "ride extraction" (judge/passB/triage with no override) render as such,
  not as false-green independent providers.
- AC-5: The embed provider (onnx worker / ollama / azure) shows its own up/down (onnx worker
  alive, ollama reachable, etc.).

## Notes

- Reuses the existing `dashboard-*-html.ts` page pattern + nav registry (same as the memory /
  jobs / search pages). New `dashboard-providers-html.ts` + a nav entry.
- Pairs with BYO (Wave 1, #414): once a user configures a BYO provider, this is where they
  SEE it's healthy. Detect (538) → show (539) → switch (BYO) = the full resilience loop.
- Sequence AFTER FEAT-538 lands (needs its providerHealth shape) — do not build in parallel
  (both touch the provider-health surface).
