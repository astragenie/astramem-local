# astramem-local — Hardening Roadmap (post-PR #29)

Status 2026-07-03: Wave 0 shipped (PR #29) · **Wave 1 shipped (PR #30)** · **Wave 2 shipped (PR #31)** ·
**Wave 3 investigated — 3.1/3.2/3.3/3.4 were already implemented** (D-DEF1 flatten `55ac082`,
ADR-005 eval gate `c0a0571`, D-DEF2 summary-id backfill `55ac082`, ADR-010 ε-fusion `f8dbc5d`);
remaining Wave-3 delta was a harness type fix + docs truth-up. Wave 4 = backlog, unscheduled.
Each wave = one PR, independently shippable, zero wire breaks unless flagged.

Operational note: W2.3 publish workflow needs the `NPM_TOKEN` repo secret set before the next release tag.

## Wave 1 — "Close the audit" (security + observability debt)

Goal: everything the deep-audit flagged that PR #29 deferred. No behavior redesign.

| # | Item | Files | Acceptance |
|---|------|-------|------------|
| 1.1 | Log rotation: `--service` mode routes pino through `pino-roll` → `<dataDir>/logs/daemon.log`, 10MB × 5 files; foreground keeps stdout. Shim passes `--service`. | `src/log/logger.ts`, `src/service/shim.ts`, `package.json` | write >10MB in test → rollover file exists; CLAUDE.md claim becomes true |
| 1.2 | Windows key-file ACL: keychain-fallback `db.key` gets `icacls <file> /inheritance:r /grant:r %USERNAME%:F`; refuse silent fallback without `--allow-file-key` when icacls fails. | `src/storage/keystore.ts` | icacls output shows single-user ACL; doctor check reports key storage mode |
| 1.3 | Doctor parity with reinstall: new checks — stranded second DB (both dirs), lingering `.pre-encryption.bak`, served-version vs build-version mismatch, zombie daemon.lock, poison-jobs > 0. | `src/doctor/checks.ts` | doctor red on each seeded condition; green on healthy box |
| 1.4 | systemd/launchd watchdog parity: `Restart=on-failure` + `RestartSec=5` (systemd), `KeepAlive` dict (launchd); remove dead `ASTRA_MEMORY_PORT` from unit OR read it in resolveRuntimeConfig (pick: read it — env between CLI flag and datadir env). | `src/service/systemd.ts`, `src/service/launchd.ts`, `src/config/resolve-runtime.ts` | unit template snapshots; crash-handler exit 1 now composes with Restart= |
| 1.5 | WAL discipline: explicit `wal_checkpoint(TRUNCATE)` on graceful shutdown + hourly checkpoint via cleanup-handler cadence. | `src/cli/serve.ts`, `src/pipeline/handlers/cleanup.ts` | WAL file shrinks after checkpoint; test with seeded writes |

Effort: ~1 slice. Risk: low — all local/process-level.

## Wave 2 — "Trust the data" (backup + supply chain)

Goal: a backup you can prove restores; no stale-install traps.

| # | Item | Files | Acceptance |
|---|------|-------|------------|
| 2.1 | `backup --verify`: after snapshot, reopen read-only, integrity_check + compare memories/transcripts counts vs live; `--json` reports verified:true. | `src/backup/snapshot.ts`, `src/cli/backup.ts` | corrupt a snapshot in test → verify fails loud |
| 2.2 | `restore` command: `astramem-local restore <snapshot>` — stop-daemon guard (instance lock), backup current DB aside, swap in snapshot, migrate, restart, health-verify. Today restore is undocumented manual file copy. | new `src/cli/restore.ts` | round-trip test: backup → mutate → restore → original counts |
| 2.3 | Registry hygiene: publish v0.6.x+ to npm on tag push (extend version-tag-parity workflow with `npm publish --provenance`), OR deprecate the package with pointer to repo install. Kills the v0.3.4-global SQLITE_NOTADB trap class permanently. | `.github/workflows/` | `npm view` shows current version; `reinstall` version-assert becomes belt-and-suspenders |
| 2.4 | Nightly backup timer default-on: `reinstall` installs the 03:00 backup task by default (`--no-backup-timer` to skip), with `--verify` wired in. | `src/cli/reinstall.ts`, `src/service/install-flow.ts` | fresh reinstall → both tasks exist |

Effort: ~1 slice. Risk: low; 2.3 needs npm auth decision (org token in CI).

## Wave 3 — "Memory quality" (the product, not the plumbing)

Goal: recall quality — the reason the daemon exists.

| # | Item | Files | Acceptance |
|---|------|-------|------------|
| 3.1 | Canonical-ingest distill fix: flatten `turns[]` to `role: text\n` prose before pipeline entry (today distill reads raw JSON.stringify — degraded memories on every v1.0-envelope ingest). Known-deferred since v0.3.0. | `src/pipeline/handlers/distill*.ts` or ingest storage | distilled memory from canonical envelope ≈ legacy-envelope quality; A/B test fixture |
| 3.2 | Retrieval regression gate: golden query set (20–30 q→expected-memory pairs from real usage) scored in CI; fail on recall@k drop. Protects alpha/beta/gamma/delta tuning. | `tests/eval/`, CI workflow | deliberate weight sabotage → CI red |
| 3.3 | Real `summary_memory_id`: Wave-3 distillation stub returns transcript UUID; return actual summary-memory UUID. Wire-compat: clients already treat it as opaque. | ingest route + distill handler | contract test asserts id resolves to a memories row |
| 3.4 | Usefulness feedback loop: `usefulness.rate_7d` is measured but unused — feed served-vs-used signal into rank (delta weight) behind config flag. | `src/search/`, config | flag off = identical ranking (snapshot test); flag on = used memories rank up |

Effort: ~1.5 slices. Risk: 3.4 needs eval gate from 3.2 first — sequence within wave.

## Wave 4 — backlog, numbered (est. hours = focused implementation incl. tests + live acceptance)

| # | Feature | What it does | Complexity | Est. |
|---|---------|--------------|------------|------|
| W4.1 | `as_of` temporal search | Point-in-time recall ("what did we believe on date T"). Schema already bitemporal (valid_from/valid_to + event log) — adds `as_of` param to search/recall SQL filter + CLI flag; unskips eval q6. | Low — filter clause + plumbing, no migration | 3–5h |
| W4.2 | Entity-based search | "Everything about <entity> X" across wordings. Distill-time entity extraction, entities+memory_entities tables, entity filter on search/recall, autocomplete + CLI, backfill for existing corpus. Design below. | High — migration 009, distill prompt change, new query path, eval fixtures | 16–24h (2 slices) |
| W4.3 | Repo/project tag hygiene | `rebuild --retag`-style pass: backfill repo/project onto untagged legacy memories (heuristic: session meta, else prompt-assisted); makes scoping + entity search trustworthy. | Low-med — one-shot job + heuristics | 4–6h |
| W4.4 | Memory TTL / archival tiers | Unbounded SQLite growth today. Policy: stale low-usefulness atoms auto-archive (valid_to + archive flag) after N months; archived excluded from vec/FTS candidates but restorable. | Med — policy design is the hard part, mechanics reuse supersede | 6–10h |
| W4.5 | `queue purge --poison` CLI | Manual poison purge ahead of the 30d auto-purge; forensics dump before delete. | Trivial | 1–2h |
| W4.6 | Remote /health scrape | Optional bind beyond 127.0.0.1 (or push-gateway) + auth for fleet dashboards. Security-sensitive: bearer on /health when non-local. | Med — small code, careful threat model | 4–6h |
| W4.7 | Sync bidirectional pull | Shipper today is one-way append-only push. Pull = cloud→local merge with conflict policy (W4.8 prereq). | High — protocol + idempotency + conflict semantics | 20h+ |
| W4.8 | Multi-device conflict policy | Same memory edited on two devices: LWW vs CRDT-ish event merge. Design doc first. | High — mostly design | 8h design + impl TBD |
| W4.9 | Parameterized embedding dim | Kill the hardcoded 1024: schema (memories_vec FLOAT[N]), config, providers, contracts, eval — the six-file coordinated change. Enables model swaps without manual surgery. | Med-high — touchy, needs re-embed migration path | 8–12h |

Suggested order if Wave 4 activates: W4.5 → W4.1 → W4.3 → W4.2 → W4.4 → W4.9 → W4.6 → W4.8 → W4.7
(cheap wins first; entity search after tag hygiene; sync last — depends on conflict design).

### W4.x Entity-based search (added 2026-07-03)

Motivation (observed): recall for "sql" returns lexically/semantically similar hits across ALL
projects — a Postgres project gets another project's "SQLite over Postgres" decisions. repo/project
filters help when tags exist, but nothing understands that "Postgres", "postgres flexible", and
"pg" are the same THING, or lets you ask "everything we know about <entity> X".

Design sketch:
1. **Extraction (distill-time)**: new pipeline stage after atom extraction — LLM (same
   qwen2.5-coder call budget) emits `entities: [{name, kind}]` per atom;
   kind ∈ product | tech | person | org | repo | concept. Normalize names (lowercase, alias
   table seedable later). Runs only on new distills; `rebuild`-style backfill command for the
   existing corpus.
2. **Schema (one migration, 009)**: `entities(id, name UNIQUE, kind)` +
   `memory_entities(memory_id, entity_id, PRIMARY KEY(memory_id, entity_id))`; index on
   entity_id. Supersede/erase cascades follow the memory row (no orphan links).
3. **Query surface (additive, wire-safe)**:
   - `search`/`recall` gain optional `entity: string` filter → resolves via entities.name
     (exact, then LIKE) → joins memory_entities → intersects with the existing FTS+vec candidate
     set before fusion.
   - `GET /entities?q=` autocomplete; `GET /entities/:id/memories` for "everything about X".
   - CLI: `search --entity postgres`, `entities list|show`.
4. **Ranking**: entity match adds a fusion bonus term (config `search.zeta`, default 0 = off
   until the retrieval eval gains entity golden queries — same never-tune-blind rule as 3.4).
5. **Eval**: extend ADR-005 corpus with entity-tagged fixtures + entity queries; regression
   floors before zeta ever moves off 0.

Effort: ~2 slices (extraction+schema+backfill; query+CLI+eval). Needs one schema migration —
the first since v0.6.0 — and a distill prompt change; wire contract stays additive.
Prereq: none hard, but repo/project tag hygiene (untagged legacy memories) makes entity scoping
more useful — consider a `rebuild --retag` pass first.

## Sequencing rationale

- Wave 1 before 2: rotation + doctor checks make Wave-2's restore/verify failures observable.
- Wave 2 before 3: touching distill/ranking without verified backups = editing memories with no undo.
- 3.2 (eval gate) before 3.4 (rank changes) inside Wave 3 — never tune ranking blind.
- Every wave: full vitest suite + live `reinstall` acceptance on Windows, same as PR #29.
