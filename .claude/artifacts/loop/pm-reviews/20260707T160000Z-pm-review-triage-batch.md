---
kind: pm-review-batch
run: runner:triage
created_at: 2026-07-07T16:00:00Z
feats: [FEAT-425, FEAT-428, FEAT-429, FEAT-437, FEAT-438, FEAT-439, FEAT-440]
scoring_source: "astra/runner 0.63.0 src/scripts/lib/pm-scorer.mts (computeCompositePriority, computeAutonomousSafe, computeWeightedCompositeScore) + src/scripts/lib/pm-effort-mapper.mts (Fibonacci band table)"
note: >
  Per runner:pm agent Boundaries, this agent does not Edit or move backlog
  FEAT files. This artifact is the scoring record; the /runner:triage skill
  (or operator, via /runner:backlog pm-write) is responsible for writing the
  pm_* frontmatter fields into each FEAT file and moving it from
  backlog/pending/ to backlog/triaged/.
---

# PM Triage Batch — 2026-07-07

## Pre-reads completed

- Read all 7 pending FEAT bodies + frontmatter (`.claude/artifacts/loop/backlog/pending/FEAT-{425,428,429,437,438,439,440}.md`).
- Lessons digest (`bun src/scripts/loop.mts lessons recent 5`): **script does not exist in this repo** (`error: Module not found "src/scripts/loop.mts"`, and no `loop.mts`/`loop.ts` or lessons-digest artifact found anywhere under this checkout outside `.claude/worktrees/*` scratch copies of an unrelated fixture generator). Treated as `insufficient data` for that specific pre-read per anti-hallucination rules; substituted the equivalent primary evidence directly — read the 5 most recent grade files instead (see Framework 4 below), which is the artifact class the digest itself summarizes.
- Cost analogs (Framework 5): `.claude/artifacts/crew/cost/*-cost-report-aggregate-*.md` — **none exist**; only 5 non-aggregate single-run reports exist (`20260704T*` / `20260705T*`), and all 5 read as `$0.0000 / 0 sessions scanned` (cost telemetry wasn't attributed to those runs). No usable $ or duration analog exists for any of the 7 FEATs below — noted "no cost analog" per Framework 5 fallback instruction on every FEAT.
- Decisions (`.claude/artifacts/loop/decisions/DEC-001..007.md`) — none reference derive-project, fusion weights, filter registries, consolidation, or the install/shim/doctor surfaces; no prior architectural constraint found for any of the 7.
- Grade history (Framework 4): read the 5 most recent grades directly — `GRADE-SLICE-411` (FEAT-413), `412` (FEAT-418), `413` (FEAT-419), `414` (FEAT-420), `415` (FEAT-421). Per-dimension 5-grade averages: architecture_quality 0.89, reliability 0.91, **observability 0.84 (lowest)**, production_readiness 0.86, security 0.85, test_confidence 0.91, product_completeness 0.92. **No dimension averages below the 0.80 weak-dimension threshold** — the Framework-4 "must include a weak-dimension AC" gate does not fire for any FEAT in this batch. Observability is the dimension to watch (lowest, though still passing); FEAT-439/440 ACs below target it anyway since both tickets are observability features by nature.
- Confirmed FEAT-423 and FEAT-426 (upstream `depends_on` for FEAT-425/428/429 respectively) are `status: done` in `backlog/done/` — those dependencies are resolved, not open.
- Read source for blast-radius/technical_risk grounding: `src/pipeline/derive-project.ts` (36 lines), `src/tag-hygiene/derive-repo.ts` (16 lines), `src/search/fuse.ts` (222 lines), `src/search/search.ts` (513 lines), `src/server/routes/consolidation.ts` (79 lines), `src/service/shim.ts` (98 lines), `src/storage/migrate.ts` (confirmed the drift-guard at line 100 cited in FEAT-438/439's incident narrative is real: `if (dbMax !== SCHEMA_VERSION)` throwing `Schema-version constant drift...`).

## Scoring formula used (found at `~/.claude/plugins/cache/astra/runner/0.63.0/src/scripts/lib/pm-scorer.mts`, cross-checked against precedent in `backlog/triaged/FEAT-414.md` and `FEAT-422.md`)

- `composite_priority`: P0 if `impact>=0.8 AND (category==bugfix OR risk>=0.8)`; else P1 if `(impact>=0.7 AND alignment>=0.6) OR (alignment>=0.8 AND effort<=0.4)`; else P3 if `effort>=0.7 AND impact<=0.3`; else P2.
- `autonomous_safe`: false if `risk>0.6 OR effort>0.6 OR dependency>0.6 OR no AC/spec`; else true (PM may still override downward — see notes per FEAT).
- `composite_score = impact*0.35 + alignment*0.30 + (1-effort)*0.20 + (1-risk)*0.10 + (1-dependency)*0.05`.
- `pm_effort_points` (FEAT-167 Fibonacci bands, `pm-effort-mapper.mts`): `[0,0.1)→1, [0.1,0.25)→2, [0.25,0.4)→3, [0.4,0.6)→5, [0.6,0.85)→8, [0.85,1.0]→13`.
- Decomposition gate (FEAT-168): `effort_points>=8` requires either `proposed_slices` (sum(points)>=effort_points) or `composite_priority: needs-review`.

---

## FEAT-425: worktree-safe project identity for cwd-derived project/repo

```json
{
  "featureId": "FEAT-425",
  "scores": {
    "customer_impact": 0.40,
    "effort_estimate": 0.15,
    "strategic_alignment": 0.40,
    "technical_risk": 0.15,
    "dependency_depth": 0.05
  },
  "compositePriority": "P2",
  "autonomousSafe": true,
  "demandEvidence": "Internal follow-up, not end-user reported: triage_notes quotes 'deriveProject's cwd-basename fallback is known to collide across git worktrees. Deliberately left out of scope for the bounded FEAT-423 correctness fix.' Real usage signal: this repo's own CLAUDE.md HARD RULES mandate worktree parallelism ('Run parallel features in sibling git worktrees'), so the loop itself is a guaranteed repeat trigger of the exact collision described.",
  "scopeNotes": "depends_on: [FEAT-423] is resolved (backlog/done/FEAT-423.md: status: done). Smallest deliverable: string-only path heuristic in the two named functions, no git/fs calls added (explicitly required by the FEAT itself). No cost analog found (Framework 5 — no aggregate cost reports exist in this repo; the 5 non-aggregate reports under .claude/artifacts/crew/cost/ all read $0.0000/0 sessions, unusable as a baseline). No weak grade dimension applies (lowest is observability at 0.84, above the 0.80 threshold).",
  "risks": [
    "Low blast radius (2 files, ~50 lines) but the heuristic is conservative-by-design; a too-aggressive strip rule could silently merge two genuinely different repos that happen to share a '-worktrees/wt-*' naming coincidence outside this repo's own convention — AC-2 in the body ('non-worktree paths unaffected') already guards this, keep it as a literal regression test, not just a stated intent."
  ],
  "reasoning": "P2 via formula (impact 0.40 < 0.7/0.8 thresholds). technical_risk banded at 0.15 (0.0-0.2 band: known repo pattern, 2 files, trivially git-revertible, string-only heuristic, no new deps). autonomous_safe true: all three risk/effort/dependency thresholds well under 0.6, and the body's proposed ACs are already Given-When-Then shaped with concrete example paths — no rewrite needed (P2, no --deep/--spec, so no acs[] emitted per FEAT-277 gating table)."
}
```

## FEAT-428: fusion-model governance — component ceiling + eval-evidence gate before eta>0

```json
{
  "featureId": "FEAT-428",
  "scores": {
    "customer_impact": 0.20,
    "effort_estimate": 0.30,
    "strategic_alignment": 0.50,
    "technical_risk": 0.20,
    "dependency_depth": 0.05
  },
  "compositePriority": "P2",
  "autonomousSafe": false,
  "demandEvidence": "none (no end-user demand) — internal arch-review finding only: derived_from arch-review-FEAT-426-2026-07-05, quote from triage_notes: 'no eval evidence that any nonzero weight helps... ADR-005 mandates this discipline for the CLOUD engine... but it was never applied to the local engine.' All three affected weights (eps/zeta/eta) ship default-0 today per FEAT-426, confirmed by the FEAT's own text — zero current production exposure.",
  "scopeNotes": "depends_on: [FEAT-426] resolved (backlog/done/FEAT-426.md: status: done). No weak grade dimension forces an additional AC. No cost analog (no aggregate reports exist; nearest-tag non-aggregate reports are $0). This is governance/ADR authorship, not implementation — smallest deliverable is the ADR text plus one CI-enforceable gate (config lint or test asserting no shipped weight>0 without an eval-delta artifact reference).",
  "risks": [
    "The FEAT's own proposed AC ('An ADR... states... A hard gate...') is a policy statement, not a testable Given-When-Then criterion with concrete values — this is exactly the vague-AC pattern the Scope Challenge framework flags as autonomousSafe:false regardless of the mechanical risk/effort/dependency thresholds (which are all individually low here).",
    "ADR authorship is architect-owned per this repo's role boundaries (crew:architect), not a builder-dispatchable implementation task — recommend runner:architect draft the ADR extension before this is slice-ready."
  ],
  "reasoning": "P2 via formula (impact 0.20, alignment 0.50 — neither P0/P1 nor P3 conditions fire). technical_risk banded 0.20 (0.0-0.2 band: pure docs + a lint/test gate, 1-2 files, trivially revertible). autonomous_safe explicitly overridden to false (mechanical thresholds alone would say true) because the body's proposed ACs are policy prose, not GWT-testable criteria, and the deliverable is architect-owned ADR authorship — flagging for runner:architect handoff rather than scoring a confident autonomous-safe green light."
}
```

## FEAT-429: filter-descriptor registry — collapse the N-file-per-signal shotgun edit

```json
{
  "featureId": "FEAT-429",
  "scores": {
    "customer_impact": 0.30,
    "effort_estimate": 0.65,
    "strategic_alignment": 0.45,
    "technical_risk": 0.50,
    "dependency_depth": 0.10
  },
  "compositePriority": "needs-review",
  "autonomousSafe": false,
  "demandEvidence": "Internal engineering-pain evidence (not end-user facing): triage_notes quotes 'at least the 4th repetition of the identical pattern' and the FEAT body names the exact ~8-file lockstep edit (fuse.ts -> search.ts -> routes/search.ts -> cli/search.ts -> cli/index.ts -> mcp/server.ts -> config -> dashboard-search-html). Cross-referenced against source: src/search/fuse.ts (222 lines) and src/search/search.ts (513 lines) confirm these are real, actively-edited files, not hypothetical.",
  "scopeNotes": "depends_on: [] in frontmatter (independent); related FEAT-424 is done. pm_effort_estimate 0.65 maps to pm_effort_points 8 (Fibonacci band [0.6,0.85)) — this trips the FEAT-168 decomposition gate. The FEAT cannot be decomposed responsibly right now because its own body asks the open question first: 'Evaluate whether a descriptor table + generated bindings is worth the indirection vs the current explicit-but-repetitive wiring' — the approach (registry+codegen vs. status quo vs. a lighter enforced-checklist test) is not yet chosen. Slicing before that choice risks sizing slices around the wrong design. No cost analog exists (no aggregate reports; nearest non-aggregate reports read $0).",
  "risks": [
    "Forcing a registry/codegen abstraction onto 7 already-working filters purely to satisfy 'no more repetition' risks the classic over-engineering trap this repo's own constitution warns about (Core Rule 2, scope discipline) — the FEAT itself hedges with 'evaluate whether... is worth the indirection', meaning even the requester isn't sure a registry is the right answer vs. a lighter enforcement test (e.g. a single test that fails when a filter is added to fuse.ts without a matching CLI/MCP/route entry, per the finding-4 arch-review pattern FEAT-424 already documents for `agent`).",
    "If a registry IS built, 'byte-identical behavior' for existing filters is a strong claim needing regression coverage across CLI, MCP schema, route parsing, and dashboard debug string simultaneously — a partial migration that silently changes wire behavior for one surface (e.g. MCP schema type coercion) is the failure mode most likely to slip past a narrow unit-test pass."
  ],
  "reasoning": "Formula would return P2, but FEAT-168's decomposition gate is mandatory once pm_effort_points>=8 and overrides to composite_priority: needs-review here (option 2 of the gate) because the FEAT resists decomposition: the architectural approach itself is undecided, so no slicing would be sized against a stable design. technical_risk banded at 0.50 (upper end of 0.3-0.5: new pattern in repo, cross-module reach across ~8 files, no schema/data change, clean git-revert rollback for the migration if done incrementally). Recommend runner:architect produce a short design note (registry+codegen vs. enforced-checklist test) before this returns to PM for effort re-scoring and slicing."
}
```

## FEAT-437: consolidation proposal backlog policy — auto-accept threshold + digest surfacing

```json
{
  "featureId": "FEAT-437",
  "scores": {
    "customer_impact": 0.60,
    "effort_estimate": 0.55,
    "strategic_alignment": 0.55,
    "technical_risk": 0.65,
    "dependency_depth": 0.15
  },
  "compositePriority": "P2",
  "autonomousSafe": false,
  "demandEvidence": "Ops evidence, quoted directly from triage_notes: '/health shows 158 pending consolidation merge proposals with zero review throughput.' FEAT body: '158 pending as of 2026-07-07, all kind: merge, throughput zero... the dedup feature delivers no value while proposals sit pending.' Confirmed the accept/reject surface is real and small: src/server/routes/consolidation.ts is 79 lines (list/accept/reject already exist per the FEAT's own Refs).",
  "scopeNotes": "depends_on: [] (independent). No weak grade dimension forces an extra AC (lowest avg is observability 0.84, still passing), though the digest-visibility AC below happens to close an observability gap anyway. No cost analog (no aggregate reports; consolidation has no prior slice in the 5 read grades to compare against — noting 'no cost analog' per Framework 5). Smallest deliverable if scope were halved: ship only the digest/dashboard visibility (count + oldest age) and the bulk CLI action for the standing 158, WITHOUT the auto-accept threshold — that alone drains the backlog under human control and defers the irreversible-merge risk below. If forced to cut further, the bulk action for the existing 158 is the one thing that must stay (it's the only path that touches the actual incident number).",
  "risks": [
    "Pre-mortem (mandatory, technical_risk=0.65>=0.6): two weeks later this fails review most likely because an auto-accepted merge at/above the similarity threshold destroys a memory that was semantically distinct despite high embedding similarity (near-duplicate phrasing, different truth values or dates) — the default-off config knob protects nobody once an operator sets a real threshold value without an eval pass on the specific corpus.",
    "Pre-mortem: rollback for the auto-accept CODE is a trivial git revert (default off, self-contained), but rollback for ALREADY-AUTO-ACCEPTED merges is NOT — consolidation merges mutate the memories table destructively, so undoing a bad auto-accept run requires restoring from a pre-merge backup/snapshot, i.e. state cleanup, not a code revert. This is exactly why technical_risk is banded at 0.65 (0.6-0.8: data-shape-changing operation, rollback needs state cleanup) rather than the lower new-pattern band.",
    "Pre-mortem: existing consolidation tests (against src/server/routes/consolidation.ts) validate the manual accept/reject API path only; none exercise a threshold-driven bulk/periodic sweep at the live 158-item backlog scale, and none currently assert that memory_events provenance distinguishes an auto-accepted merge from a manually-accepted one — that distinction is exactly what the tightened AC-2 below must cover, and it is the coverage gap a naive 'accept endpoint already has tests' assumption would miss."
  ],
  "reasoning": "P2 via formula: impact 0.60 falls short of the 0.7 P1 threshold and alignment 0.55 falls short of the 0.8 P1-alternate threshold, despite real, quoted ops evidence — this is active product-quality debt (dead-weight dedup feature, growing queue) rather than an active outage, which is the calibration line drawn against FEAT-438/439/440 below. autonomous_safe is false mechanically (technical_risk 0.65>0.6) because auto-accept is an irreversible data-mutation feature — default-off protects today's behavior but any enabled threshold needs human sign-off on the value and the bulk-resolution UX for the existing 158 before an autonomous pass should touch it. Per FEAT-277 gating (P2, no --deep/--spec passed), no acs[] emitted here — but see scopeNotes for the AC tightening this needs before a future P1/--deep pass: (1) default-preserved happy path, (2) auto-accept + memory_events provenance tagging as `auto_accepted:true`, (3) below-threshold digest/dashboard visibility, (4) bulk resolution for the standing 158 with distinct provenance, (5) config-validation failure on an out-of-range threshold."
}
```

## FEAT-438: release-pinned install — service runs an immutable versioned copy, not the dev tree

```json
{
  "featureId": "FEAT-438",
  "scores": {
    "customer_impact": 0.90,
    "effort_estimate": 0.65,
    "strategic_alignment": 0.85,
    "technical_risk": 0.80,
    "dependency_depth": 0.15
  },
  "compositePriority": "P0",
  "autonomousSafe": false,
  "demandEvidence": "Direct, dated production-incident evidence, quoted from triage_notes and body: 'Root fix for the 2026-07-07 8h outage: the OS service points current.json at the dev checkout's dist/, so every merge/worktree-agent mutation can strand the running service (schema drift guard fired: dist said 15, DB said 16).' Verified in source: src/storage/migrate.ts line 100 contains exactly the cited guard (`if (dbMax !== SCHEMA_VERSION) throw ... 'Schema-version constant drift...'`), confirming the incident narrative against real code, not just the ticket's own claim.",
  "scopeNotes": "depends_on: [] (independent — it is the root of the 438/440 chain, FEAT-440 depends on it). No cost analog exists for an install/release-topology change of this shape in the 5 available cost reports (all $0, unrelated slices) — 'no cost analog' per Framework 5. Smallest deliverable if forced to halve scope: ship the release-materialization + pointer-repoint + served-version assert (closes the actual incident mechanism) and defer retention/pruning + rollback command to a fast-follow — but the FEAT's own AC-3 (retention/rollback) and AC-4 (--dev escape hatch) are cheap relative to the AC-1/AC-2 core and should stay if effort allows, per the proposed_slices split below.",
  "risks": [
    "Pre-mortem (mandatory, P0 + risk>=0.6): most likely two-week-later failure cause is native-module bundling breaking inside the materialized release dir — better-sqlite3/SQLCipher and sqlite-vec are explicitly called out in the FEAT body as unbundleable, needing a real `node_modules` via `bun install --production` or a copy of the checkout's prod subset; a bun/Node ABI or platform mismatch there would make the 'immutable' release itself fail to boot, recreating the exact silent-degradation class this FEAT exists to fix, one layer deeper and harder to see.",
    "Pre-mortem: rollback is NOT a simple git revert once this merges and misbehaves — `reinstall --rollback` requires a previous release directory to already exist (none will, on first rollout), so recovery falls back to the `--dev` escape hatch (manual repoint to the checkout's dist) or a manual current.json edit + schtasks-independent restart; this is real operational rollback complexity, not a code-only revert, which is exactly why technical_risk is banded at the 0.6-0.8 ceiling (0.80) rather than lower.",
    "Pre-mortem: no existing test exercises the real OS-level schtasks task + shim + genuine native-module resolution end-to-end — unit tests of reinstall.ts's directory/pointer logic could pass green while the live task never actually restarts cleanly on a real machine; the FEAT's own kill-test AC ('deleting or rebuilding the repo's dist/ does not affect the running service') must be run for real on a live Windows install, not mocked, or this exact gap reopens.",
    "Injection-defense note: no embedded imperative found in this FEAT's body or triage_notes — content read as pure incident narrative and requested capability, nothing quoted or flagged as an injection attempt."
  ],
  "reasoning": "P0 via formula: impact 0.90>=0.8 AND technical_risk 0.80>=0.8 (the alternate P0 condition, since category is default 'feature' not 'bugfix' — title does not match ^fix:/^hotfix:). technical_risk banded at the 0.6-0.8 ceiling (0.80): cross-module reach (install/CLI/service/doctor/CLAUDE.md docs) plus the FEAT's own explicit call for an architect 'design decision... install-into-release vs copy' (an unresolved unknown bordering the 0.9-1.0 'unknowns needing a spike' band, but kept at 0.80 rather than pushed into 0.9+ because the pointer-repoint mechanism itself reuses an already-atomic, already-proven pattern in this repo — CLAUDE.md's FEAT-433 atomic tmp-file+rename writeConfig — so the repoint step is not itself a spike, only the native-module packaging choice is). autonomous_safe false mechanically on BOTH effort (0.65>0.6) and risk (0.80>0.6) independently. pm_effort_points=8 (band [0.6,0.85)) trips the FEAT-168 decomposition gate — proposed_slices below satisfies it (sum 13>=8).",
  "acs": [
    "AC-1: Given `reinstall` runs, When it materializes `%LOCALAPPDATA%\\Astramem\\releases\\<pkgversion>+<gitsha>\\` containing `dist/` and a production `node_modules` (via `bun install --production` or an equivalent prod-subset copy), Then `current.json.entryJs` is repointed to that release's `dist/cli/index.js`, the shim restarts the daemon, and `GET /version` reports the release's `pkgversion`+`gitsha` matching the served-version-equals-build-version assert compared against the release manifest.",
    "AC-2: Given the service has been reinstalled to point at a versioned release directory, When the repo checkout's own `dist/` is deleted or rebuilt (e.g. a worktree agent running `bun run build` against a newer migration, as happened 2026-07-07), Then the running daemon is unaffected until an explicit `reinstall` runs again — `GET /health` stays `ok` and the served schema version (per `src/storage/migrate.ts:100` SCHEMA_VERSION check) does not change.",
    "AC-3: Given two consecutive `reinstall` runs have each materialized a new release directory, When a third `reinstall` completes, Then exactly 2 release directories remain under `%LOCALAPPDATA%\\Astramem\\releases\\` (oldest pruned); Given `reinstall --rollback` is then run, Then `current.json` repoints to the immediately-previous release and `GET /version` reports that release's version after restart.",
    "AC-4 (edge case): Given an operator runs `reinstall --dev`, When the shim starts the daemon, Then `current.json.entryJs` points at the repo checkout's `dist/cli/index.js` (today's behavior, unchanged) and `doctor` reports a loud, unambiguous 'dev-pinned' warning distinguishing this state from a release-pinned install.",
    "AC-5 (failure/native-module edge case): Given `bun install --production` into the release directory fails (e.g. a native module fails to build for the target platform), When `reinstall` detects the failure, Then it aborts BEFORE repointing `current.json`, the previously-served release keeps running unaffected, and the failure is surfaced loudly (non-zero exit + message) rather than leaving a half-materialized release directory as the new pointer target."
    ],
  "proposed_slices": [
    { "id_suffix": "-SLICE-1", "title": "Release dir materialization (dist + prod node_modules) + AC-5 failure guard", "points": 5 },
    { "id_suffix": "-SLICE-2", "title": "Pointer repoint + served-version assert against release manifest (AC-1, AC-2)", "points": 3 },
    { "id_suffix": "-SLICE-3", "title": "Retention/prune + --rollback + --dev escape hatch + doctor/CLAUDE.md updates (AC-3, AC-4)", "points": 5 }
  ]
}
```

## FEAT-439: migration-merge currency — post-merge build+reinstall trigger + doctor schema-drift probe

```json
{
  "featureId": "FEAT-439",
  "scores": {
    "customer_impact": 0.85,
    "effort_estimate": 0.55,
    "strategic_alignment": 0.80,
    "technical_risk": 0.55,
    "dependency_depth": 0.30
  },
  "compositePriority": "P1",
  "autonomousSafe": true,
  "demandEvidence": "Same incident as FEAT-438/440, second-layer framing quoted directly: 'Merging a PR with a migrations/ file changes nothing about the running service: no rebuild, no reinstall, no warning... The drift is invisible until the next service restart fails (2026-07-07: 8h crash-loop).' Body explicitly notes the doctor-probe half is implementable independent of FEAT-438: 'the doctor probe + hook are implementable against today's layout too.'",
  "scopeNotes": "depends_on: [] in frontmatter; body notes only a soft/conceptual dependency on FEAT-438 for 'which release is served', consistent with the task framing ('FEAT-439 is soft-dependent'). No weak grade dimension mandates an extra AC (observability avg 0.84, passing) but AC-5 below targets it anyway since this ticket is itself an observability feature. No cost analog (no aggregate reports). Recommend defaulting the 'candidate homes (architect picks)' choice to the FEAT's own suggested safest option — both the git post-merge hook AND the loop-ceremony check, hook as backstop — rather than treating it as an open architect gate; this keeps the ticket builder-dispatchable. Coordination note: this ticket and FEAT-440 both read/write doctor.ts (439 adds the schema-drift RED finding, 440 adds the crash-loop RED finding) — sequence them as two reviewed diffs against doctor.ts rather than parallel dispatch, per Core Rule 1 (one owner per file at a time).",
  "risks": [
    "Pre-mortem (mandatory, P1): most likely two-week-later failure cause is the 'non-blocking-safe' rebuild trigger silently swallowing its own failure (fire-and-forget rebuild with no surfaced badge) — the ticket would then claim the drift gap is closed while a broken trigger reproduces the exact silent-failure shape of the original incident.",
    "Pre-mortem: rollback is revert-only if implemented as a git post-merge hook + local loop-ceremony check (no migration, no cross-plugin coordination) UNLESS the hook is packaged into the astra/runner plugin template itself, in which case rollback needs a version bump in that separate repo (the same cross-repo hazard already documented for FEAT-422's rules.md drift) — scope this as repo-local first.",
    "Pre-mortem: no existing test exercises a real git merge to main touching migrations/ triggering a real rebuild end-to-end; CI validates build/test scripts in isolation, not the merge-to-rebuild wiring itself — the kill-test AC-1 below (a live or simulated merge) is the only thing that closes this gap."
  ],
  "reasoning": "P1 via formula: impact 0.85>=0.7 AND strategic_alignment 0.80>=0.6 (first P1 condition). technical_risk banded at 0.55 (upper end of 0.3-0.5: new repo pattern — build automation triggered off git state — combined with cross-module reach into doctor.ts and the loop ceremony, but no schema/data change and a clean revert path). autonomous_safe true: all three gating thresholds (risk 0.55, effort 0.55, dependency 0.30) sit under 0.6, and GWT ACs are supplied below — kept true rather than overridden, since the 'architect picks' ambiguity has a safe builder-resolvable default (implement both, hook as backstop) named in the FEAT's own text.",
  "acs": [
    "AC-1: Given main advances with a commit touching `migrations/` (e.g. a new migration file), When the post-merge trigger fires, Then `bun install && bun run build && reinstall` completes and a subsequent `GET /version` on the daemon reports the new build's version within the trigger's completion window.",
    "AC-2: Given `doctor` runs, When the served release's `SCHEMA_VERSION` (from `src/server/lib/wire-meta.ts`, cross-checked against the guard at `src/storage/migrate.ts:100`) differs from the live DB's `MAX(user_version)`, Then `doctor` FAILs with a RED 'schema drift' finding printing both version numbers and a copy-pasteable `reinstall` fix command.",
    "AC-3 (failure path): Given the rebuild triggered by the post-merge hook fails (e.g. `bun run build` exits non-zero), When the trigger observes the failure, Then the merge itself is not blocked or reverted, the previously-served release keeps serving, and the failure is surfaced via a `help_request` badge or equivalent stderr/artifact — never silently swallowed.",
    "AC-4 (rebuild-storm edge case): Given N commits touching `migrations/` land on main within one `git pull`/merge batch, When the post-merge trigger evaluates the batch, Then exactly one rebuild runs, not N (de-duped).",
    "AC-5 (observability / matched-version green path): Given the served release's schema version and the live DB's schema version match, When `doctor` runs, Then it reports GREEN for the schema-drift check, and running it again immediately afterward stays GREEN with no side effects — closing the loop on the lowest-scoring grade dimension in the last 5 grades (observability, avg 0.84)."
  ]
}
```

## FEAT-440: crash-loop visibility — shim exit history + crash stderr capture + doctor alert

```json
{
  "featureId": "FEAT-440",
  "scores": {
    "customer_impact": 0.85,
    "effort_estimate": 0.45,
    "strategic_alignment": 0.75,
    "technical_risk": 0.45,
    "dependency_depth": 0.35
  },
  "compositePriority": "P1",
  "autonomousSafe": false,
  "demandEvidence": "Direct incident evidence quoted from triage_notes and body: 'the 2026-07-07 outage crash-looped every 5 min for 8h with ZERO trace — launch.cjs uses stdio:inherit so schtasks discards crash stderr... schtasks Last Result: 1 was the sole trace.' Verified src/service/shim.ts exists (98 lines) as the real file this FEAT targets.",
  "scopeNotes": "depends_on: [FEAT-438] — explicit and NOT yet resolved (FEAT-438 is itself pending in this same batch). The FEAT body states this outright: 'FEAT-440 depends_on FEAT-438 because that ticket rewrites the same shim — land the new shim once.' No cost analog (no aggregate reports). Smallest deliverable if halved: ship exit-history + crash.log capture (the two mechanisms that would have actually shortened the 8h incident) and defer the toast stretch AC (already marked 'optional (stretch AC)' in the FEAT's own body) and possibly the doctor RED integration to a fast-follow tied to FEAT-439's doctor work (both 439 and 440 touch doctor.ts — see coordination note on FEAT-439 above).",
  "risks": [
    "Pre-mortem (mandatory, P1): most likely two-week-later failure cause is the exit-history/crash-log write path itself throwing on a locked or read-only logs directory, and — despite the explicit 'must never throw' requirement in the FEAT body — an unhandled exception there prevents the shim from spawning the daemon at all, turning an observability-only feature into a NEW outage vector, which is the worst possible regression for this specific ticket.",
    "Pre-mortem: rollback is revert-only — this is a single shim file (already being rewritten once alongside FEAT-438 per the stated depends_on) plus a doctor.ts read-path addition; `git revert` fully restores prior (silent) behavior, no migration or cross-plugin coordination needed. This low rollback cost is exactly why technical_risk sits at 0.45 rather than higher, even though the correctness bar (never block the daemon spawn) is subtle.",
    "Pre-mortem: no existing test simulates a real OS-level crash-loop via the schtasks keepalive (inherently a live Windows integration scenario) — a unit test of launch.cjs's append logic could pass while the real keepalive-driven rapid-respawn path still races on ring-buffer truncation; the FEAT's own kill-test AC (config broken, 3+ real restarts) is the only thing that would catch this, and it must run for real, not mocked.",
    "Same-file collision risk: FEAT-440 explicitly targets the same shim file FEAT-438 is rewriting, and both are pending/unbuilt right now. Dispatching this autonomously before FEAT-438 lands (or without combining them into one shim-rewrite pass) risks two independent diffs against the same file landing out of order — this, not the mechanical risk/effort/dependency thresholds (all individually <=0.6), is the specific reason autonomous_safe is overridden to false below."
  ],
  "reasoning": "P1 via formula: impact 0.85>=0.7 AND strategic_alignment 0.75>=0.6. technical_risk banded at 0.45 (upper-middle of 0.3-0.5: new pattern — crash-loop detection in the spawn path — confined to one module (shim.ts) plus a doctor.ts read-path addition, no schema/data change, cheap git-revert rollback). autonomous_safe is a PM override to false: the mechanical thresholds (risk 0.45, effort 0.45, dependency 0.35) would all individually pass the <=0.6 bar, but the explicit, FEAT-body-stated same-file sequencing dependency on the not-yet-built FEAT-438 ('land the new shim once... or land 438 first') is a real one-owner-per-file hazard (Core Rule 1) that the dimension thresholds don't capture on their own — safe to build once FEAT-438 lands or as a combined shim-rewrite pass, not safe to dispatch independently right now.",
  "acs": [
    "AC-1: Given the daemon exits (any exit code), When `launch.cjs` observes the child process close, Then it appends `{ts, exitCode, durationMs}` as one line to `%LOCALAPPDATA%\\Astramem\\logs\\exit-history.jsonl`, ring-buffered to the last 50 entries.",
    "AC-2: Given the daemon crashes before its file logger opens (e.g. the `src/storage/migrate.ts:100` schema-drift throw — the exact 2026-07-07 failure mode), When the shim's piped stderr receives that output, Then the verbatim error text is persisted to `%LOCALAPPDATA%\\Astramem\\logs\\crash.log` (rolling, last ~64KB), readable after the process has already exited.",
    "AC-3 (edge case — reproduces the incident): Given exit-history shows >=3 consecutive non-zero exits within the recent window, When `doctor` runs, Then it reports a RED 'crash loop' finding printing the exit codes, the time span, and the tail of `crash.log`; Given the config is then fixed and the daemon produces one zero-exit run, Then the consecutive-failure counter resets and the next `doctor` run is GREEN.",
    "AC-4 (failure-isolation / never-throw guarantee): Given the logs directory is locked or read-only, When history/crash-log writes fail, Then the write failure is swallowed (never throws) and the daemon spawn proceeds unaffected — verified by a test that makes the logs dir unwritable and asserts the daemon still starts.",
    "AC-5 (healthy fast-exit isolation): Given the instance lock causes a healthy no-op fast-exit (<100ms, exit 0), When this is recorded in exit-history, Then it does NOT count toward the crash-loop streak — exit 0 resets the consecutive-failure counter, distinguished from a real crash via the recorded `durationMs`."
  ]
}
```

---

## Summary for downstream write-back

| FEAT | composite_priority | pm_effort_points | autonomous_safe | decomposition gate |
|---|---|---|---|---|
| FEAT-425 | P2 | 2 | true | n/a |
| FEAT-428 | P2 | 3 | false (override: vague AC, architect-owned) | n/a |
| FEAT-429 | needs-review | 8 | false | fired — resists decomposition, needs architect design choice first |
| FEAT-437 | P2 | 5 | false (mechanical: risk 0.65) | n/a |
| FEAT-438 | P0 | 8 | false (mechanical: effort+risk) | fired — satisfied via proposed_slices (3 slices, 13 pts) |
| FEAT-439 | P1 | 5 | true | n/a |
| FEAT-440 | P1 | 5 | false (override: same-file dependency on unbuilt FEAT-438) | n/a |

`declined_per` not applicable — no FEAT in this batch scored P4 or was declined.
