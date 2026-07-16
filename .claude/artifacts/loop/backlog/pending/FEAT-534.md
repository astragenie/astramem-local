---
id: FEAT-534
status: pending
priority: null
category: quality
target_release: null
created: 2026-07-16
updated: 2026-07-16
depends_on: []
slices: []
derived_from: null
github_issue: null
github_milestone: null
github_url: null
---
# FEAT-534: Per-pass extraction provider — surgical cloud pass A + greedy local pass B

## Description

Dual-pass extraction (`distill.extractionPasses: 2`, shipped default) runs
BOTH passes on the single `llm.extraction` provider. Add an optional
`distill.extractionPassB: { provider?, model? }` override (mirroring the
contradiction-judge shape from PR #373: unset = byte-identical today's
behavior, either half overridable, governance drops invalid provider
values on the loadConfigFromDisk boot path) so pass A and pass B can run
on different models.

## Why (evidence, 2026-07-16 extraction bench, 43 fixtures, same judge)

| Model | Recall | Precision | F1 | Junk | Atoms/fx |
|---|---|---|---|---|---|
| codex gpt-5.4-mini | 49% | 94% | 64% | 4% | 2.5 |
| qwen3:8b (local) | 84% | 70% | 76% | 28% | 6.5 |

Opposite profiles: codex is surgical (misses half, never wrong), qwen3:8b
is greedy (finds nearly everything, ~30% junk). Pass A is the primary
extraction; pass B is the specifics SWEEPER — hunting what pass A missed
is a recall task, exactly the local model's strength. The hybrid
hypothesis: codex pass A anchors precision, qwen pass B recovers the
missed-recall tail, at HALF the metered cost of full-codex dual-pass
(prod currently runs extractionPasses: 1 on codex partly for cost/lane
reasons — a free pass B changes that calculus).

## Requested capability

1. `distill.extractionPassB: { provider?, model? }` — optional; unset
   inherits `llm.extraction` exactly as today. Applied ONLY when
   `extractionPasses: 2`.
2. Wire through `extractSpecifics`/`callExtract`'s existing path — pass B
   already goes through the same `callExtract` with a prompt override;
   this adds a provider override at the same seam. jsonSchema (#369)
   applies to both passes unchanged.
3. Governance on the boot path (loadConfigFromDisk chain — NOT loadConfig;
   see PR #373's dead-governance finding) dropping invalid provider
   values, warn-never-fatal.
4. Run-manifest / providers CLI visibility: `providers` output and eval
   run manifests must show pass A and pass B assignments distinctly —
   a silent model mix is an ADR-015 hazard.
5. Extraction-bench support: a spec syntax for mixed-pass runs (e.g.
   `--models codex:gpt-5.4-mini+passB=qwen3:8b`) so the hybrid hypothesis
   is MEASURED against both single-model rows before any default change.

## Acceptance criteria (sketch)

- Given extractionPassB unset, when a 2-pass distill runs, then both
  passes use llm.extraction and behavior is byte-identical to today.
- Given extractionPassB = ollama/qwen3:8b with llm.extraction = codex,
  when a 2-pass distill runs, then pass A chat calls hit codex and pass B
  chat calls hit ollama (pinned by a capture-provider unit test), and the
  distill event/log records both models.
- Given an invalid extractionPassB.provider in config.yaml, when the
  daemon boots, then the override is dropped with a warning and boot
  succeeds (loadConfigFromDisk governance test).
- Given the extraction bench run in mixed mode, when the report renders,
  then the model column identifies the pass split and per-pass atom
  counts are recorded (measurement gate for adopting hybrid as default).

## Out of scope

- Automatic failover between providers (quota-exhausted fallback) —
  explicitly rejected for now: silent mid-corpus quality shift is an
  ADR-015 violation; failover needs its own loud design.
- Changing prod's extractionPasses default — separate operational
  decision gated on the hybrid bench numbers.
