# LoCoMo run ledger

One row per archived run — newest last. Full provenance in each folder
(run-manifest.json + sandbox-config.yaml + metrics.json). Rows marked
`recon:` predate the 2026-07-18 provenance fix — their params are
reconstructed from launch commands and artifacts, not recorded manifests.
Archive new runs with `bun scripts/eval/locomo/archive-run.mts --run-dir <dir> --name <slug>`.

**Two scales live here — do NOT compare across them.** `n=1986` = full suite (the
real number). `n=199` = conv-1, a single-conversation 10% sample (fast iteration;
must be full-sample-reconfirmed before publishing). See `README.md`.

| date | name | score | n | params |
|---|---|---|---|---|
| 2026-07-13 | first-scored-run | 0.2362 | 1986 | recon: early run, 1853/1986 answers abstained — extraction near-zero (~0.5 atoms/session). Artifact `.claude/artifacts/crew/runs/20260713T020500Z-locomo-first-scored-run.md` |
| 2026-07-13 | full-suite-baseline | 0.4610 | 1986 | recon: category-avg 0.4007. `docs/research/20260713-locomo-full-suite-result.md` (+ `-metrics.json`) |
| 2026-07-14 | nocompact (full suite best) | 0.4840 | 1986 | recon: compaction OFF; category-avg 0.4137; 2 categories regressed. `docs/research/20260714-locomo-nocompact-0484-result.md` |
| 2026-07-18 | (historical) champion conv-liberal | 0.6002 | 199 | recon: passes=2(inherited-default) sweep=untuned prompt=conv-liberal k=15 extract=codex/gpt-5.4-mini · 558 atoms · run dir deleted, artifacts-only — NOT reproducible same-recipe (see replicate row) |
| 2026-07-18 | [20260718-ministral-gated-sweeper](20260718-ministral-gated-sweeper/) | 0.5143 | 199 | recon: passes=2(inherited) sweep=none-yet prompt=conv-liberal k=15 extract=codex/gpt-5.4-mini passB=ollama/ministral-3:8b evidenceGate=auto-on · 301 atoms |
| 2026-07-18 | [20260718-control-codex-solo](20260718-control-codex-solo/) | 0.5502 | 199 | recon: passes=1(via uncommitted default flip, see memory: sabotage) prompt=conv-liberal k=15 extract=codex/gpt-5.4-mini · 268 atoms |
| 2026-07-18 | [20260718-control-codex-dual-tuned](20260718-control-codex-dual-tuned/) | 0.5362 | 199 | recon: passes=2(pinned) sweep=tuned-defaults(gate8/cap1500) prompt=conv-liberal k=15 extract=codex/gpt-5.4-mini · 299 atoms |
| 2026-07-18 | [20260718-replicate-champion-untuned](20260718-replicate-champion-untuned/) | 0.5346 | 199 | passes=2 sweep=untuned prompt=conv-liberal k=15 extract=codex-subscription/gpt-5.4-mini git=02c167b4 · 448 atoms · exact champion recipe, −6.6 vs champion = codex day-variance PROVEN |
| 2026-07-19 | [20260719-chunkab-800tok](20260719-chunkab-800tok/) | 0.5430 | 199 | passes=2 sweep=tuned-default prompt=conv-liberal k=15 extract=codex-subscription/gpt-5.4-mini git=fcbadce2 |
| 2026-07-19 | [20260719-chunkab-3200tok](20260719-chunkab-3200tok/) | 0.5264 | 199 | passes=2 sweep=tuned-default prompt=conv-liberal k=15 extract=codex-subscription/gpt-5.4-mini git=fcbadce2 |
| 2026-07-19 | [20260719-chunkab-1600tok](20260719-chunkab-1600tok/) | 0.5110 | 199 | passes=2 sweep=tuned-default prompt=conv-liberal k=15 extract=codex-subscription/gpt-5.4-mini git=27ca053f |
| 2026-07-19 | [20260719-sweeperv1-800tok](20260719-sweeperv1-800tok/) | 0.5167 | 199 | passes=2 sweep=tuned-default prompt=conv-liberal k=15 extract=codex-subscription/gpt-5.4-mini git=27ca053f |
| 2026-07-20 | [20260720-baseline-v2](20260720-baseline-v2/) | 0.5112 | 199 | passes=inherited-default prompt=conversational k=15 extract=codex-subscription/gpt-5.4-mini git=277bb06 · cat: sh 0.437 mh 0.266 tmp 0.555 od 0.316 adv 0.809 · **-6pt vs board = day-variance live** |
| 2026-07-20 | [20260720-multihop-v2](20260720-multihop-v2/) | 0.5511 | 199 | --multihop ON (verified) k=15 prompt=conversational extract=codex/gpt-5.4-mini · cat: sh 0.483 mh 0.302 tmp 0.613 od 0.348 adv 0.830 · **CONFOUNDED: separate distill vs baseline, +0.040 uniform across ALL cats = day-variance signature not decompose. Needs same-store A/B to isolate.** |
