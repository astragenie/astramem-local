# astramem-local — Hardening Roadmap (post-PR #29)

Status 2026-07-04: Wave 0 shipped (PR #29) · **Wave 1 shipped (PR #30)** · **Wave 2 shipped (PR #31)** ·
**Wave 3 investigated — 3.1/3.2/3.3/3.4 were already implemented** (D-DEF1 flatten `55ac082`,
ADR-005 eval gate `c0a0571`, D-DEF2 summary-id backfill `55ac082`, ADR-010 ε-fusion `f8dbc5d`);
remaining Wave-3 delta was a harness type fix + docs truth-up. **Wave 4 shipped (PR #37)** — all
nine features (W4.1–W4.9), SCHEMA_VERSION 8→13, + post-wave architect/TS review fixes.
Wave 5 = backlog below, unscheduled.
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

## Wave 5 — backlog, numbered (drafted 2026-07-04, post-Wave-4 review)

Sources: Wave-4 follow-ups (architect + TS holistic reviews), handoff open items
(3g rerank, consolidation v1.x, Cursor), and the deferred cloud-sync contract work.

| # | Feature | What it does | Complexity | Est. |
|---|---------|--------------|------------|------|
| W5.1 | Sync completion: cloud pull contract + daemon loop | Define the real cloud `GET /sync/pull` response shape (atom-body transport — today's `atom_snapshot` is a local assumption; push envelope carries no atom body). Zod-validate the `httpPullFetcher` boundary. Add a scheduled daemon pull loop mirroring `startShipper` (pull is CLI-only today — two daemons never auto-converge). Prove a live A→cloud→B round trip. | High — cross-repo contract design + local loop; conflict engine already built (ADR-011) | 12–18h (needs cloud repo) |
| W5.2 | Consolidation v1.x — LLM passes | Lesson abstraction (N episodic atoms → 1 semantic lesson) + contradiction detector (proposal queue already reserves `kind='contradiction'`). Proposal-only (never destructive), same review surface as stage-9 merges. | High — prompt design + eval fixtures; plumbing exists | 10–16h |
| W5.3 | Cloud rerank rollout (3g) | Execute ticket astramem-local#26: go/no-go, second TEI container (BAAI/bge-reranker-v2-m3 proposal), dev flip → A/B NDCG delta → prod → publish the delta (ADR-005 gate rule). ⚠️ 300 ms hard cap (DEC-011/012) on the shared CI box. | Med — code 100% built cloud-side, `Search:CrossEncoder:Enabled=false`; this is rollout + measurement | 4–8h (mostly cloud repo + ops) |
| W5.4 | Wire parity: retrieval-query.v1 gains `entity` + `as_of` | Local search grew entity/as_of filters (W4.1/W4.2); the shared cloud/local ADR-005 wire envelope (`contracts/schemas/retrieval-query.v1.schema.json`) doesn't know them. Additive schema change + SaaS-side handling so plugin/SaaS callers can use both. | Med — additive, two repos | 4–6h |
| W5.5 | ADR rulings + review-debt batch | (a) ADR addendum: as_of × archival (time-travel currently surfaces archived-for-staleness content — make it a decision); (b) document archival = local-only sync policy (or design propagation as ADR-011 addendum); (c) ADR-011 rule-coverage checklist: new event type / new supersede side-effect ⇒ "does conflict-resolve.ts need a rule?"; (d) normalize fusion weights (sum 1.1 today); (e) doctor/providers CLI schema-dim parity check (boot has it, tooling doesn't); (f) test nits (05-extract name, 403 partially-tagged idempotency case). | Low — docs + small diffs, batchable in one slice | 3–5h |
| W5.6 | Cursor capture adapter | Revisit postponed 4c decision: Cursor's chat store is a proprietary SQLite blob; Cursor users currently get MCP recall only (documented in docs/codex-capture.md). Re-evaluate feasibility vs demand before building. | Med-high — reverse-engineering risk; spike first | 4h spike, impl TBD |
| W5.7 | Launch (2f) | Marketplace publish + announcement post. Operator/user task; needs `NPM_TOKEN` repo secret before the release tag (W2.3 note). | Trivial-med — ops/comms | 2–4h |

Suggested order if Wave 5 activates: **W5.5 → W5.4 → W5.2 → W5.1 → W5.3 → W5.7 → W5.6**
(rulings + parity first — they unblock and de-risk everything sync-shaped; consolidation is
pure-local value independent of the cloud; sync completion and rerank need the cloud repo;
launch when the story is coherent; Cursor spike last, gated on demand).

Dependencies: W5.1 needs cloud-repo access + the SaaS team's contract sign-off; W5.3 needs the
pending go/no-go (#26); W5.4 touches the same schema file as W5.1 — sequence them, don't parallelize.
W5.2 must respect the never-tune-blind rule: contradiction/lesson fixtures extend the ADR-005
corpus BEFORE any ranking-visible effect ships (same discipline as ε and ζ).

## Sequencing rationale

- Wave 1 before 2: rotation + doctor checks make Wave-2's restore/verify failures observable.
- Wave 2 before 3: touching distill/ranking without verified backups = editing memories with no undo.
- 3.2 (eval gate) before 3.4 (rank changes) inside Wave 3 — never tune ranking blind.
- Every wave: full vitest suite + live `reinstall` acceptance on Windows, same as PR #29.
