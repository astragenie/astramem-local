# docs/ — map

One-screen guide to what lives where. If you're about to create a new doc, check here first for
where it belongs before adding a new top-level file or folder.

## Agent-facing (read first)

| File | What |
|---|---|
| `memory.md` | Durable-facts index — dated corrections, current eval numbers, known gaps, closed/known debt. **Supersede in place**, don't append-forever. |

## Reference (product docs, linked from README.md)

| File | What |
|---|---|
| `configuration.md` | Full `config.yaml` reference |
| `providers.md` | Ollama and Azure OpenAI setup |
| `capture-protocol.md` | `astramem-capture@1` wire contract (`transcript` + `events` kinds) |
| `retrieval-presets.md` | Named retrieval presets (`preset=default\|recent\|exact\|entity\|temporal`) |
| `recall-filters.md` | Recall/search filter reference |
| `migration-from-saas.md` | Switching the plugin from remote SaaS to local daemon |
| `contracts.md` | Frozen type interfaces (for contributors) |
| `troubleshooting.md` | Common issues and fixes |
| `backup-recovery.md` | Backup / restore procedures |
| `embed-dim-migration.md` | Changing the embedding dimension (`reembed-dim`) |
| `codex-capture.md` | Codex CLI capture connector |
| `memory-tool-adapter.md` | memory-tool adapter design |
| `hardening-roadmap.md` | Cross-cutting hardening plan (waves) |
| `hooks/memory-pack.md` | SessionStart memory-pack hook (auto-installed by `init`) |

## Design and decision records

| Dir | What | Naming |
|---|---|---|
| `adr/` | ADR-001..020 — architecture decision records | `ADR-NNN-slug.md` |
| `architecture/` | Design package: reading-order `README.md`, `target-architecture.md`, `architecture-review.md` (W1–W8 known weaknesses), `migration-map.md` (build waves) — produced 2026-07-02, still the design reference | descriptive kebab-case |
| `specs/` | Design/remediation specs, mostly dated 2026-07-13; **`20260713-teardown-remediation-plan.md`** is the live one per `CLAUDE.md`'s architecture-verdict pointer | `YYYYMMDD-slug.md` or `FEAT-NNN-slug.md` |

## Eval / research (dated investigation records — historical, not live instructions)

| Dir | What | Naming |
|---|---|---|
| `eval-runs/` | **Canonical LoCoMo/eval run tracker.** Read `eval-runs/README.md` first — one archived folder per scored run + `LEDGER.md` (one row per run) + `BASELINE-CONSTANTS.md` (tuned recipe). If a number isn't backed by a folder here, it's unverified. | `<date>-<slug>/` |
| `eval/` | Eval-harness methodology docs (LoCoMo, LongMemEval, extraction-proof) | descriptive |
| `research/` | 40+ dated investigation records (teardown-and-reinvent, LoCoMo hypothesis ledger, competitor analysis, packaging audits, postmortems). Point-in-time — cross-check dates against `docs/memory.md` before trusting a conclusion as still current. | `YYYY-MM-DD-slug.md` or `YYYYMMDD-slug.md` |
| `perf/` | Perf baselines | dated |
| `prompts/` | Prompt-engineering research artifacts | dated |
| `superpowers/{plans,specs}/` | Superpowers-skill-generated plans/specs — separate tool from `specs/` above, same "dated doc" shape | `YYYY-MM-DD-slug.md` |

## Operations

| Dir/File | What |
|---|---|
| `runbooks/release-publish.md` | Cut-a-release runbook — daemon + `contracts/` + `audio-addon/` (each an independently-tagged npm package). A `v*` tag push auto-publishes via CI; see `docs/memory.md`'s publish-flow correction before assuming a manual `npm publish` step is needed. |
| `runbooks/cross-encoder-rerank.md` | Cross-encoder rerank design/ops notes |
| `security/remote-health-threat-model.md` | Threat model for the remote-health surface |

## Historical / low-priority

| Item | Status |
|---|---|
| `HANDOFF.md` | 2026-07-02 point-in-time snapshot (v0.6.0 state). Not referenced by any current instruction file — kept for archival value, superseded going forward by `memory.md`. |
| `todo/v0.1.2.md` | Sole file in `todo/`, 19+ releases stale. Likely fully superseded — owner should confirm and delete (see `memory.md` known debt). |

## Conventions

- Dated docs use `YYYY-MM-DD-slug.md` or `YYYYMMDD-slug.md` (both forms exist in this repo's
  history; either is acceptable, prefer the hyphenated form for new files).
- ADRs are the only sequential-numbered doc type (`ADR-NNN`); specs use `FEAT-NNN` when tied to a
  tracked feature, a date prefix otherwise.
- A dated doc is a point-in-time record, not a live instruction — if you need current state, check
  `memory.md` or `eval-runs/README.md` first, not a research-dir file's headline claim.
