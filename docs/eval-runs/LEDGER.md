# LoCoMo run ledger

One row per archived run — newest last. Full provenance in each folder
(run-manifest.json + sandbox-config.yaml + metrics.json). Rows marked
`recon:` predate the 2026-07-18 provenance fix — their params are
reconstructed from launch commands and artifacts, not recorded manifests.
Archive new runs with `bun scripts/eval/locomo/archive-run.mts --run-dir <dir> --name <slug>`.

| date | name | score | n | params |
|---|---|---|---|---|
| 2026-07-18 | (historical) champion conv-liberal | 0.6002 | 199 | recon: passes=2(inherited-default) sweep=untuned prompt=conv-liberal k=15 extract=codex/gpt-5.4-mini · 558 atoms · run dir deleted, artifacts-only — NOT reproducible same-recipe (see replicate row) |
| 2026-07-18 | [20260718-ministral-gated-sweeper](20260718-ministral-gated-sweeper/) | 0.5143 | 199 | recon: passes=2(inherited) sweep=none-yet prompt=conv-liberal k=15 extract=codex/gpt-5.4-mini passB=ollama/ministral-3:8b evidenceGate=auto-on · 301 atoms |
| 2026-07-18 | [20260718-control-codex-solo](20260718-control-codex-solo/) | 0.5502 | 199 | recon: passes=1(via uncommitted default flip, see memory: sabotage) prompt=conv-liberal k=15 extract=codex/gpt-5.4-mini · 268 atoms |
| 2026-07-18 | [20260718-control-codex-dual-tuned](20260718-control-codex-dual-tuned/) | 0.5362 | 199 | recon: passes=2(pinned) sweep=tuned-defaults(gate8/cap1500) prompt=conv-liberal k=15 extract=codex/gpt-5.4-mini · 299 atoms |
| 2026-07-18 | [20260718-replicate-champion-untuned](20260718-replicate-champion-untuned/) | 0.5346 | 199 | passes=2 sweep=untuned prompt=conv-liberal k=15 extract=codex-subscription/gpt-5.4-mini git=02c167b4 · 448 atoms · exact champion recipe, −6.6 vs champion = codex day-variance PROVEN |
| 2026-07-19 | [20260719-chunkab-800tok](20260719-chunkab-800tok/) | 0.5430 | 199 | passes=2 sweep=tuned-default prompt=conv-liberal k=15 extract=codex-subscription/gpt-5.4-mini git=fcbadce2 |
| 2026-07-19 | [20260719-chunkab-3200tok](20260719-chunkab-3200tok/) | 0.5264 | 199 | passes=2 sweep=tuned-default prompt=conv-liberal k=15 extract=codex-subscription/gpt-5.4-mini git=fcbadce2 |
| 2026-07-19 | [20260719-chunkab-1600tok](20260719-chunkab-1600tok/) | 0.5110 | 199 | passes=2 sweep=tuned-default prompt=conv-liberal k=15 extract=codex-subscription/gpt-5.4-mini git=27ca053f |
| 2026-07-19 | [20260719-sweeperv1-800tok](20260719-sweeperv1-800tok/) | 0.5167 | 199 | passes=2 sweep=tuned-default prompt=conv-liberal k=15 extract=codex-subscription/gpt-5.4-mini git=27ca053f |
