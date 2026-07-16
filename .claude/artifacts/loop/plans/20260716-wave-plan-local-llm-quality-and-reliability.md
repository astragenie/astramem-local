# Wave plan — local-LLM quality + reliability track (2026-07-16)

status: architect-reviewed-amended (2026-07-16; challenger review pending resend)
owner: lead (interactive session)
context: qwen3:8b won the 43-fixture judged extraction bench (F1 76% vs prod
codex 64%); compaction flipped local today; contradiction judge live in
dry-run on qwen3:8b (#373); LoCoMo A/B (extraction=qwen3:8b) in flight.
This plan sequences the 8 next items into conflict-free parallel waves.

## Ground rules

- One worktree per slice (sibling `astramemory-local-worktrees/wt-<slice>`),
  never the primary checkout (a second interactive session owns it).
- Every slice: builder → independent reviewer → validator (behavior) →
  PR with auto-merge on green. Squash merges; migrations take their number
  from origin/main at push time (migration-collision rule).
- File-claim discipline: waves are built from the file-conflict matrix
  below; if a builder discovers scope creep into another slice's files,
  STOP and re-scope (constitution).
- GPU: Ollama is owned by the LoCoMo eval until it completes (~17-19:00).
  No slice in waves 1-2 needs live Ollama; FEAT-533/534 bench validation
  runs AFTER LoCoMo frees the GPU.

## File-conflict matrix (why the waves are shaped this way)

| Slice | Hot files |
|---|---|
| FEAT-534 pass-B provider | config.ts, loader.ts, pipeline.ts, 05-extract.ts, run-bench.mts, providers/index.ts, pipeline/handlers/distill.ts (architect amend) |
| FEAT-533 atom triage | config.ts, loader.ts, durability-gate.ts, 08-embed-index.ts, new migration, doctor check |
| #370 watchdog re-arm | schtasks.ts, install-flow.ts, watchdog-probe.ts, doctor check |
| #372 consolidation ops | consolidate.ts, server routes, MCP tools, cli/consolidate.ts |
| #352B supersession→recall | search/search.ts, fuse.ts |
| #284 profile-gated compaction | pipeline.ts, 04-compact.ts, config.ts (distill block) |
| #341 silent-client (local half) | tests/contracts, server ingest route docs |
| FEAT-492 embed cache | storage/embed-cache.ts, 08-embed-index.ts |

Conflicts driving sequencing: 534⨯533⨯284 share config.ts/pipeline.ts;
533⨯492 share 08-embed-index.ts.

## Wave 1 (4 parallel worktrees)

| Slice | Builder | Notes |
|---|---|---|
| W1-A FEAT-534 pass-B provider | crew:fullstack-dev | #373-pattern config + governance; capture-provider tests; bench spec syntax. NO default change. |
| W1-B #370 watchdog re-arm | crew:fullstack-dev | ARCHITECT-PINNED DESIGN: ADD a `<TimeTrigger StartBoundary=now>` alongside (not replacing) LogonTrigger in task-xml.ts's buildTaskXml — one fix point covers both tasks (schtasks.ts:146,:369 share it); schedule-type /sc switch REJECTED (regresses the ExecutionTimeLimit=PT0S fix). Bug recurs on EVERY reinstall (adapter.install() re-creates with /f each time — install-flow's 'exactly once' comment is stale; fix that comment too). Doctor canary on LastRunTime staleness > 3× interval. Validator: throwaway task name only — install() has no dry-run. |
| W1-C #372 consolidation ops | crew:backend-dev | Pagination at the REPO layer (ProposalRepo.list, proposals.ts:79) so HTTP/MCP/CLI/dashboard inherit it (FEAT-456 SLICE-2 precedent); min-confidence is NOT a column — parse metadata_json in-repo, fetch-filter-slice in JS. Batch-resolve MCP tool + CLI; flip candidateSelection knn PRIORITY RAISED: first live run showed 17 skipped groups holding 28,097 atoms — 76% of corpus never scanned in 'full' mode. MCP tool addition MUST update contracts/manifests/mcp-tools.v1.json + parity tests (cross-repo SoT). |
| W1-D #352B supersession→recall | crew:backend-dev | HARD CONSTRAINT (architect): any staleness signal enters via applyFusionGovernance's componentKeys array + eval-evidence gate (config.ts:1285-1329) — never summed ad hoc in fuse.ts. Builder locates the exact fuse.ts scoring loop BEFORE implementing. Recall-eval floors (recall@10>=0.9, NDCG>=0.7) must hold. |

Wave-1 exit gate: all four PRs merged green + `/runner:phase-gate`-style
suite pass on main.

## Wave 2 (3 parallel, after W1 merges)

| Slice | Builder | Notes |
|---|---|---|
| W2-A FEAT-533 atom triage | crew:fullstack-dev | rebases on 534's config/loader shape; dry-run ONLY this wave; migration number from origin/main at push. |
| W2-B #284 profile-gated compaction | crew:fullstack-dev | shouldCompact seam exists; conversational→skip-or-light policy; A/B evidence from LoCoMo ablation (no-compact 0.484) in the FEAT notes. |
| W2-C #341 local half | crew:backend-dev | daemon-side contract test pinning flat project/agent on POST /ingest + RememberRequest parity; the plugins-common serialization fix is a SEPARATE cross-repo PR (astramem-plugin repo) — tracked, not built here. |

## Wave 3 (2 parallel, after W2)

| Slice | Builder | Notes |
|---|---|---|
| W3-A FEAT-492 embed cache | crew:backend-dev | 08-embed-index free after 533 merges; content-hash keyed on (text, model, dim, revision). |
| W3-B Bench validation batch | crew:verifier | GPU free post-LoCoMo: FEAT-534 hybrid bench row; FEAT-533 dry-run agreement vs Azure judge labels; judge dry-run verdict sample review → go/no-go for `enabled`. |

## Explicitly out of plan

- #306 / #328 — release-blocker track, separate.
- FEAT-487 ranking signals — killed by measurement (rank-miss 13%).
- Prod default flips (extraction→local, extractionPasses→2, judge→enabled,
  triage→enabled) — each gated on its wave-3 measurement, operator sign-off.

## Risks

1. Two interactive sessions + wave builders share one repo: stash is
   OFF-LIMITS (repo-global); artifact/state files churn in every worktree —
   builders commit only their slice's files, never `git add -A`.
2. #370 validator needs real schtasks mutation on the prod box — must NOT
   deregister the live daemon's task; test against a THROWAWAY task name,
   only the final PR touches install-flow.
3. 534+533 land adjacent governance edits in loader.ts across waves —
   W2-A builder must read #373's dead-governance postmortem first.
4. LoCoMo owns Ollama: any slice sneaking a live-model test before wave 3
   will both flake and pollute the eval — mock providers only in W1/W2.
