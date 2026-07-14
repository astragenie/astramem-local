# FEAT-495 item 4b — dormant-seams sweep (astramem-local)

**Type:** disposition list (inventory only — nothing activated or deleted in this pass)
**Scope:** `astramem-local` repo, worktree `wt-l1-4-hardening`, grep for `enabled:` flags + stub/TODO branches
**Sibling:** cloud memory repo's FEAT-523 (same sweep, other repo)
**Method:** `grep` every `enabled:` default in `src/config/config.ts`'s `defaultConfig()`, then traced each to its call site to confirm wired-vs-dead; cross-checked against this repo's own `CLAUDE.md` "Known open gaps" section for items already tracked there (cited, not re-investigated, to avoid duplicating existing findings).

Disposition legend: **activate** = flip on / build the missing half now; **delete** = dead code, remove; **keep-dormant** = correctly off by design, leave as-is.

## Config-gated features (all found genuinely wired — none are dead code wearing a feature flag)

| # | Seam | Evidence (file:line) | Disposition | Why |
|---|---|---|---|---|
| 1 | Cross-encoder rerank (`crossEncoder.enabled`) | `src/search/rerank.ts:253` (`if (!config.crossEncoder.enabled) return undefined`), consumed by `src/search/search.ts:200,866` | keep-dormant | Real reranker wired end-to-end (`buildCrossEncoderProvider`, `src/search/rerank.ts:231`); off by default because it needs a sidecar HTTP reranker or non-mock provider. Not orphaned — a config edit alone activates it. |
| 2 | Multi-hop query decomposition (`multiHop.enabled`) | `src/search/decompose.ts:14` doc comment, `resolveDecomposeOpts`; config surfaced in `src/config/writer.ts:258-265` | keep-dormant | WS6 feature, off pending further eval per its own doc comment. Wired, not dead. |
| 3 | Recall pack (`recallPack.enabled`) | `src/recall/policy.ts`, `src/server/routes/recall.ts`, `src/cli/init.ts` | keep-dormant | Wired to a real route; off by default, config-flip activates. |
| 4 | Tag-hygiene tier 2 (`tagHygiene.tier2Enabled`) | `src/cli/retag.ts:34-47`, `src/tag-hygiene/backfill.ts:93,128` | keep-dormant | Has its own CLI opt-in (`retag --tier2`) independent of the config default — this one is MORE reachable than most, a user can flip it per-invocation without touching config.yaml. |
| 5 | Archival (`archival.enabled`) | `src/pipeline/handlers/cleanup.ts:4,75-78` calls `runArchivalPass` every cleanup pass unconditionally; `src/storage/archival.ts` implements the age+usefulness-floor policy | keep-dormant | Genuinely invoked every cleanup cycle — a no-op only because `enabled:false`, not because nothing calls it. |
| 6 | Auto-capture (`capture.autoCapture.enabled`) | ADR-012, `src/doctor/checks/auto-capture.ts` | keep-dormant | Already documented rationale (security model gate) — see ADR-012. |
| 7 | LLM-proxy Tier 3 (`proxy.enabled` / `proxy.capture.enabled`) | ADR-013, `src/proxy/server.ts:349` (binds a real listener when enabled) | keep-dormant | Already documented (ADR-013) — daemon-mandatory design already noted in this repo's `CLAUDE.md`. |
| 8 | Distill cost cap (`distill.costCap.enabled`) | `src/config/config.ts:794-804` doc comment | keep-dormant | Explicitly reasoned beta default (friction vs BYO-quota tradeoff) already in the comment immediately above the flag — nothing to add. |
| 9 | LLM-judged junk sample (`memoryHealth.llmJudgedJunkSample.enabled`) | `src/cli/memory-health.ts:15,60,135` | keep-dormant | CLI-gated opt-in (`memory-health` command prints how to turn it on); wired end to end. |
| 10 | Sync push (`sync.enabled`) | `src/sync/shipper.ts` — see this repo's `CLAUDE.md` "Sync bridge" section | keep-dormant | Shipped and live when enabled + paired; opt-in by design (privacy: nothing leaves the device until the operator asks). Not a forgotten seam — this is the CLAUDE.md entry that was previously WRONG in the other direction (said "no sync bridge" when one shipped) — the opposite failure mode of a dormant seam, worth remembering as a caution about trusting doc state over code. |

## Findings that are NOT simple "off by config" — more actionable

| # | Seam | Evidence | Disposition | Why |
|---|---|---|---|---|
| 11 | Sync **pull** path (`src/sync/puller.ts`) | `puller.ts` file header: "no cloud-side endpoint... `sync pull` would 404" (confirmed no `/sync/pull` route exists in the cloud repo's `SyncController.cs` per this repo's own `CLAUDE.md`) | **activate-or-document** (not keep-dormant-silently) | This is a genuine cross-repo half-built feature, not a config-off feature — a curious operator running `astramem-local sync pull` today gets a raw 404 with no guidance. Two options, either is fine: (a) build the cloud endpoint (real feature work, out of this bundle's S-effort scope), or (b) cheapest immediate fix — have the CLI `sync pull` subcommand print a clear "not supported by any shipped cloud version yet" message instead of letting the request 404 raw. Recommend (b) as a follow-up FEAT if not already tracked; did not implement here (scope: FEAT-495 is items 1/2/3/4a, this is 4b inventory only). |
| 12 | `checkMemoryHealth`'s single return path | `src/doctor/checks.ts` per this repo's `CLAUDE.md` "Known open gaps" — `{ok: true}` unconditionally, so a 100% distill-poison rate still reports "memory health: OK" | **activate** (already tracked, not re-derived here) | This is the ADR-015 "success and silent failure look identical" bug class by name. Already known — citing, not re-discovering. Real fix: wire a failure branch off `distillSessionStats().poisonRate` (already computed in `src/server/queries/memory-health.ts`, just never read by this specific check). |
| 13 | `llmChatProbe` never exercises `format:json` | `src/doctor/probes/llm-chat-probe.ts:19-22` per `CLAUDE.md` | **activate** (already tracked) | The exact request shape that broke qwen3 in production is never probed. Already known; citing. |
| 14 | Four zero-writer tables (`messages`, `artifacts`, `provider_state`, `evidence_guard_drops`) | per `CLAUDE.md` "Known open gaps" | **mixed** (already tracked) | `provider_state` is the worst of the four — nothing writes it but `src/server/queries/dashboard.ts:245` reads it, so it's an always-empty dashboard widget shipping to users. `messages`/`artifacts` are day-one tables with zero writers in this repo's whole history — candidates for **delete** after confirming no external reader depends on the table shape. `evidence_guard_drops` is in-flight (a guard counter, same family as the other `*_guard_drops` tables this bundle's own item 1/3 pattern-matches against) — likely just needs its writer wired, not deleted. Already tracked in `CLAUDE.md`; citing, not re-investigating in this pass — worth a dedicated small FEAT.

## Confirmed absent (checked, not assumed)

- **Audio/STT/whisper.cpp capture**: grepped `src/**/*.ts` for `whisper`/`audio` — zero real implementation exists in this repo today (`src/doctor/checks/memory-sentinel.ts:302` mentions FEAT-489 only as a FUTURE VRAM-pressure consideration in a comment, not shipped code). A prior memory note about a "dormant audio STT pipeline" among 4 cross-repo findings does **not** apply to this repo as it stands — confirmed via exhaustive grep rather than repeating that note on trust (per this repo's own "absence claims need exhaustive search" lesson). If that finding is real, it belongs to a different repo in the astramem family.
- No stub/`NotImplemented` vector-store backend or alternate-provider branch found in `src/` beyond the documented `sqlite-vec` default — this repo genuinely ships one backend, unlike the cloud repo's unimplemented `QdrantVectorStore`.

## Summary for the lead

Zero truly orphaned/dead seams found in this pass — every `enabled: false` config default traced to real, wired, reachable code with an already-documented rationale for shipping off. The actionable items are #11 (sync pull's silent-404 UX gap) and #12-14 (already tracked in this repo's own CLAUDE.md, restated here only for consolidation into one disposition list per the FEAT-495 ask — no new code changed for any of these in this pass, per scope: 4b is inventory-only).
