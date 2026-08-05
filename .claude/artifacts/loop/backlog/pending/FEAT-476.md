---
id: FEAT-476
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-13
updated: 2026-08-05
depends_on: [FEAT-458]
slices: []
derived_from: .claude/artifacts/crew/handoffs/20260712T230000Z-feat458-waves-orchestrator-handoff.md
cross_product: [astramem-local]
autonomous_safe: null
triage_notes: "Rewritten 2026-08-05 after adversarial architecture review (kb/12-research/token-cost-monitoring-2026-08/feat-476-review.md) found the original spec's attribution join structurally broken (proxy session_id is a random UUID per exchange, project_id a fixed sentinel — no real correlator) and its derived-only pricing model silently loses cost on any exchange the FEAT-478 relevance gate discards. Still not PM-scored."
---
## Description

**Agent-run cost attribution — turn tokens into dollars, and dollars into slices,
without lying about what we don't know.**

FEAT-458's proxy capture fork records raw usage (`input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`, `stop_reason`, `model`)
per exchange in `transcripts.proxy_usage_json`, in raw counts only — no dollar
figures. This FEAT is the read side: a durable cost ledger, a pricing model that
can represent real per-provider pricing rules (not just flat per-token rates), an
attribution join with an honest confidence contract, and a report.

**This is Phase-0 of a possibly larger product** (see
`kb/12-research/token-cost-monitoring-2026-08/verdict.md`) — build it as a
1-2 week internal tool, but choose a data model that doesn't have to be thrown
away if it grows.

## Non-goals (explicit)

- Billing, invoicing, quota enforcement, spend limits.
- Cloud-side (astramem SaaS) cost attribution — separate FEAT.
- Full multi-provider pricing complexity: Bedrock, Azure OpenAI PTU, GCP Vertex —
  each has a fundamentally different reconciliation join (see
  `kb/.../stage2/raw/reconciliation-feasibility.md`) and is out of scope until a
  design partner needs it. Anthropic + OpenAI only for v1.
- OpenAI's fast-mode, flex-mode, and data-residency pricing dimensions — modeled
  as a named gap in the price table (see Accuracy-trap checklist), not silently
  ignored, but not implemented this slice.
- Anthropic Cost Report API reconciliation (matching this report's totals against
  the actual bill) — high-value, explicitly deferred to a follow-up FEAT once this
  ledger exists to reconcile against.
- Any broad rework of `src/capture/proxy.ts`'s relevance gate, dedup, or wire
  parsing. The ONE narrow exception is AC-5 below (decoupling usage capture from
  gate-discard) — in scope because it fixes an active undercount bug, not because
  this FEAT owns the capture path.

## Data model decision: `cost_events` + `price_versions`, not a derived-only JSON blob

**Position:** replace "derive everything from `transcripts.proxy_usage_json` at
read time" with two new tables. Dollar amounts are still never stored as a column
— that part of the original spec's instinct was right. What was wrong was tying
the *facts* (token counts, model, provider, timestamp, attribution keys) to the
`transcripts` row's lifecycle.

- **`cost_events`** — one row per captured exchange, independent of whether the
  transcript itself was gated/redacted/purged: `id, source ('proxy'|'otel'),
  captured_at, provider, model, input_tokens, output_tokens,
  cache_read_input_tokens, cache_creation_input_tokens, stop_reason, truncated,
  session_key, slice_id (nullable), agent_role (nullable), dedup_key`. Populated
  by BOTH ingest paths (see Dual ingest below). Never purged by the transcript
  purge flow — cost history has its own retention policy.
- **`price_versions`** — `provider, model, tier ('standard'|'priority'|'batch'),
  effective_from, effective_to (nullable = current), input_rate, output_rate,
  cache_read_multiplier, cache_write_multiplier, source ('config'|'manual-correction')`.
  Effective-dated so a genuine provider price change and a manual typo-correction
  are both representable without conflating "what was billed at the time" with
  "what we now believe the rate should have been."
- **Cost is still always a query**, joining `cost_events.captured_at` against the
  `price_versions` row whose `[effective_from, effective_to)` window contains it.
  No `amount_usd` column anywhere. AC-1/AC-2 below encode this.

**Why not the derived-only-JSON-blob model as originally spec'd:** it can't
represent a real historical price change (only a correction), it ties cost
survival to transcript survival (directly causes the AC-5 bug), and it has no
query surface for grouping/joining without loading and parsing every row's JSON
in application code.

**Migration:** additive. New tables, populated going forward. Backfill from
existing `transcripts.proxy_usage_json` rows is a one-time script, best-effort
(pre-migration rows may lack `slice_id` if the time-window join can't resolve
them — that's fine, they land in the unattributed bucket, AC-7).

## Dual ingest: proxy tee + Claude Code native OTel

The proxy tee cannot see `session.id` or `agent.name` — `session_id` in
`src/capture/proxy.ts` is a fresh random UUID per exchange (proxy.ts:702) and
`project_id` is a fixed sentinel (`'llm-proxy'`, proxy.ts:197). This is a
structural property of body-only capture, not a bug to fix in that module.

Claude Code's own OTel export (env-var config only, no proxy required) emits
`claude_code.api_request` with `cost_usd`, all 4 token types, `model`,
`agent.name`, `skill.name`, `session.id`. **This is the correct attribution
source when available; the proxy tee is the fallback for non-Claude-Code traffic
or when OTel export isn't configured.**

- In scope: an OTel collector/exporter that writes `cost_events` rows with
  `source: 'otel'` and real `session_id`/`agent_role` from the native fields.
- In scope: a `dedup_key` (hash of provider+model+captured_at+token-counts,
  loosely time-bucketed) so an exchange visible on both paths simultaneously
  (proxy routes AND OTel export both enabled) is not double-counted — prefer the
  OTel row when both exist for the same exchange (richer attribution).
- Out of scope (Phase-1): non-Claude-Code harnesses (LangGraph, homegrown) —
  `capture-matrix.md` confirms these require opt-in instrumentation per
  framework, no default emitter exists yet.

## Accuracy-trap checklist (from `reconciliation-feasibility.md`, encoded as scope)

`price_versions` must be able to express, even if v1 only populates a subset:

| Trap | Provider | v1 status |
|---|---|---|
| Cache read discount (~10% Anthropic, ~90% OpenAI) | both | **implemented** (`cache_read_multiplier`) |
| Cache write premium (1.25× Anthropic; OpenAI 1.25× GPT-5.6+ only, 1.0× before) | both | **implemented**, model-conditional via `tier`/model match, not a global constant |
| Batch discount (50% off) | both | **implemented** (`tier: 'batch'`) |
| Priority Tier separate billing, excluded from Anthropic's own Cost API | Anthropic | **surfaced as unpriced** if `tier` isn't populated for it — never silently priced at standard rate |
| Long-context repricing (2× input+output, model-dependent) | both | named gap, out of scope this slice — any turn hitting a known long-context model is flagged "pricing may be inaccurate — long-context tier not modeled" rather than silently wrong |
| Fast mode 2×, data residency +10% | OpenAI | out of scope this slice, named gap |

## Attribution join contract

- Primary key: `cost_events.session_key` (real `session.id` for OTel rows;
  synthetic per-exchange id for proxy rows, which therefore cannot resolve to a
  slice via session identity and fall through to the time-window path below).
- Time-window fallback (proxy rows only): match `captured_at` against
  `.claude/state/crew/workflow-state.json`'s `currentRun`/`recentRuns` entries by
  `[startedAt, completedAt]`. **If zero windows contain the timestamp: bucket as
  `unattributed`. If more than one window contains it (concurrent worktrees —
  confirmed the normal case in this repo): bucket as `ambiguous (N candidates)`,
  never guess one.** This is a deliberate accuracy floor, not a TODO — concurrent
  slices are the common case here, not an edge case.
- `agent_role` is only populated when the ingest source actually carries it
  (OTel `agent.name`); proxy-sourced rows always have `agent_role: null` and are
  reported under an explicit "role unknown (proxy-only capture)" line, not
  silently omitted from the role breakdown.

## Report deliverables

CLI `cost` surface, minimum:

- Cost per slice / FEAT (from `cost_events` joined through the attribution
  contract above), with an explicit `unattributed` and `ambiguous` line — never
  silently dropped from totals.
- Cost per model, cost per agent role (where known).
- Cache-hit ratio and cache read vs. write cost, as distinct line items.
- Truncated-reply count (`stop_reason` in `{max_tokens, length}`).
- Unknown-usage count (AC-3) and unpriced-model count (AC-4), both excluded from
  totals but visibly reported as counts.
- A visible warning line for any `cost_events` row whose model matches a known
  long-context threshold that isn't priced (accuracy-trap gap above).

## Acceptance criteria

- AC-1 — Given a `cost_events` row with raw usage, model, provider, and
  `captured_at`, when the cost report runs, then it joins against the
  `price_versions` row whose effective window contains `captured_at` and derives
  a dollar figure at read time; no dollar amount is stored as a column on
  `cost_events`, `transcripts`, or anywhere else.

- AC-2 — Given a `price_versions` row is corrected for a past effective window
  (not a new price version — an actual data-entry fix), when the cost report
  re-runs over the same historical `cost_events`, then every affected historical
  figure reflects the corrected rate. Given instead a genuine new price version is
  added with a fresh `effective_from`, historical figures for events before that
  date are unaffected — proving the model distinguishes "we were wrong" from
  "the price changed."

- AC-3 — Given a captured exchange whose usage is absent from the provider
  response (e.g. OpenAI streaming without `stream_options.include_usage`), when
  the report runs, that exchange is reported as unknown-cost and excluded from
  totals, with a visible "N exchanges, unknown usage" count — never silently
  counted as $0.

- AC-4 — Given a model id with no matching `price_versions` row, when the report
  runs, those turns are surfaced as unpriced with the model id named, excluded
  from totals, never priced at zero or a guessed default.

- AC-5 — Given a proxy exchange whose assistant turn is discarded by the
  relevance gate (FEAT-478 Option A, `src/capture/proxy.ts` gating logic) but
  whose response body carried real provider usage, when the exchange completes,
  then a `cost_events` row is still written for it, decoupled from whether the
  transcript envelope itself is spooled. (Requires a narrow, coordinated change
  to `finishCapture()` in `src/capture/proxy.ts` — compute and persist usage
  telemetry before either early-return, not after. Flag for sign-off from
  whoever owns FEAT-458/478 given the original spec's "no proxy changes" scope
  line; if that coordination doesn't land in this slice, the fallback is a loud,
  named "N exchanges discarded by relevance gate, cost unknown" count in the
  report — never a silent gap.)

- AC-6 — Given the same physical exchange is observable via both the proxy tee
  and Claude Code's native OTel export (both enabled), when both ingest paths
  write a `cost_events` row for it, then the dedup key prevents double-counting,
  and the OTel-sourced row (richer attribution) is preferred over the proxy row
  when both exist.

- AC-7 — Given a `cost_events` row's `captured_at` falls within exactly one
  `currentRun`/`recentRuns` window with a live slice id, when the report groups
  by slice, that row's cost is attributed to that slice. Given it falls within
  zero windows, it is bucketed `unattributed`. Given it falls within more than
  one overlapping window (concurrent worktrees), it is bucketed
  `ambiguous (N candidates)` — never guessed.

- AC-8 — Given `cost_events` carrying `cache_read_input_tokens` and
  `cache_creation_input_tokens`, when the report runs, cache reads and cache
  writes are reported as distinct line items (never summed into one "cache"
  number) and a cache-hit ratio is derived. Given a row with `stop_reason` in
  `{max_tokens, length}`, it is counted and surfaced as a truncated reply.

## Risks and notes

- **AC-5 is the one item that breaks the original "no capture-path changes"
  boundary.** Deliberate — the alternative is shipping a cost ledger that is
  known, on day 1, to systematically undercount exactly the turns (terse reply,
  expensive context) that matter most. If coordination with the capture owner
  can't happen this slice, ship with the loud-count fallback and file the
  capture-path fix as a fast-follow, not a silent gap.
- **Concurrent-worktree ambiguity is not a corner case here.** `workflow-state.json`
  shows 4+ overlapping slice windows as routine. The `ambiguous` bucket in AC-7
  will be non-trivial in size; report it prominently, don't bury it.
- **Proxy-path attribution is inherently second-class.** `session_id`/`project_id`
  on proxy-captured rows carry no real identity (structural, per
  `src/capture/proxy.ts`'s own module doc). Do not build UI/reporting that implies
  proxy-sourced rows have the same attribution confidence as OTel-sourced rows.
- **Capture must be ON, and traffic must actually route through the proxy or emit
  OTel, for any of this to work.** Verify (as a manual check, not an AC) that
  parallel worktree sessions actually have the base-URL override / OTel env vars
  set — otherwise the report silently samples an arbitrary subset of real spend
  while presenting totals as if complete.
- **Two pricing tables will exist** (`runner-plugin`'s `cost-rate-table.mts` for
  the harness's own estimate, `price_versions` here for the billed receipt) —
  legitimate design (estimate vs. receipt), but stated explicitly rather than
  read as an oversight; do not silently diverge on model naming conventions
  between them. Note `deriveCostUsd` in the existing table returns 0 for unknown
  models — the exact anti-pattern AC-4 forbids; do not reuse it verbatim.

## Strategic note

astramem sells a memory API for AI agents. Cost + cache + tool-use telemetry per
agent turn is a second product through the same integration. Per
`kb/12-research/token-cost-monitoring-2026-08/verdict.md`: this alone does not
clear the bar to compete with astramem-local for founder attention (finalist
score 63/100, below the 75 threshold) — build as the no-regret internal tool
(O-G) it verdict-scored as, not as a product commitment.
