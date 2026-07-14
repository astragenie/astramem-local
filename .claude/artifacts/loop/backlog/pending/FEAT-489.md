---
id: FEAT-489
status: pending
priority: null
category: capture
target_release: null
created: 2026-07-14
updated: 2026-07-14
depends_on: [FEAT-496, FEAT-497]
slices: []
derived_from: memory repo docs/research/2026-07-14-final-report-transcription-memory-2week-plan.md
---
# FEAT-489: Audio file ingestion — `transcribe` pipeline handler + whisper.cpp add-on

## Description

Drop an audio file (wav/mp3/m4a) into the daemon and get distilled, private-by-default memories:
new `transcribe` pipeline handler (registered in `src/pipeline/registry.ts` alongside
distill/consolidate/reembed/cleanup) that runs on-device ASR and feeds the existing 8-stage
distill. On-device transcription keeps `private`-scope recordings on the device — the privacy
story no hosted competitor matches; team/org atoms still sync via the existing shipper.

Packaging: whisper.cpp binding + model download ship as an OPTIONAL add-on package
(`@astragenie/astramem-audio` or similar), NOT in base `astramem-local` — keeps base install
light and creates the future paid-add-on seam. Config-gated per repo convention:
`audio.enabled: false` default, dry-run mode first.

> **Arch review 2026-07-14 (applied):** (1) contract fields now owned by FEAT-496 —
> `evidence[].transcript_id/span` already exist in atom@2; only `speaker_label` +
> `segment_start_ms` are missing (additive/minor). (2) Consent/disclosure ADR (FEAT-497) gates
> slice 1 — recording non-user speakers has no ADR-009 coverage today; ADR-012 precedent applies.
> (3) Packaging needs a short design pass BEFORE build: no second-published-package precedent in
> this repo (no workspaces/optionalDependencies; `better-sqlite3-multiple-ciphers` +
> `trustedDependencies` at `package.json:54-57` is the native-module precedent to follow). Decide:
> add-on presence probe (dynamic import + try/catch), base<->add-on version pinning, second
> publish pipeline (release runbook is single-package today). (4) **v1 ships CPU-only whisper.cpp
> build — pinned constraint, not preference**: a CUDA/Metal build would silently reintroduce the
> exact GPU/VRAM failure class `src/doctor/gpu-checks.ts` exists to catch.

## Acceptance hints

- `astramem-local ingest-audio <file>` (or POST to existing ingest route with audio) → transcript
  → distill → ≥1 memory with transcript provenance, all on-device.
- Base package installs and runs with the add-on absent — audio config surfaces a clear
  "add-on not installed" message, never a crash.
- Transcript segments conform to the canonical segment/provenance contract extension (authored in
  this repo's `contracts/` per the cloud 2-week plan — coordinate, don't fork).
- Doctor check: audio-enabled-but-addon-missing or model-missing surfaces in `astramem doctor`
  (the "built, wired, never invoked" canary pattern — this repo's own lesson).

## Notes

Watch GPU/VRAM contention with distill's Ollama models (known orphan llama-server VRAM trap).
Whisper.cpp on CPU is acceptable for file ingest (not latency-sensitive). FEAT-490 (confidence
filter) gates this handler's output.
