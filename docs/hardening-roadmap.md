# astramem-local — Hardening Roadmap (post-PR #29)

Status: proposed 2026-07-03. Wave 0 (install fragility + runtime survival) shipped as PR #29.
Each wave = one PR, independently shippable, zero wire breaks unless flagged.

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

## Wave 4 — "Scale + fleet" (when multi-machine matters)

Backlog, not scheduled: sync shipper bidirectional pull; multi-device conflict policy; memory TTL/archival tiers (SQLite file growth unbounded today); `queue purge --poison` CLI; remote /health scrape endpoint for fleet dashboards; sqlite-vec → parameterized dim (the six-file coordinated change noted in CLAUDE.md).

## Sequencing rationale

- Wave 1 before 2: rotation + doctor checks make Wave-2's restore/verify failures observable.
- Wave 2 before 3: touching distill/ranking without verified backups = editing memories with no undo.
- 3.2 (eval gate) before 3.4 (rank changes) inside Wave 3 — never tune ranking blind.
- Every wave: full vitest suite + live `reinstall` acceptance on Windows, same as PR #29.
