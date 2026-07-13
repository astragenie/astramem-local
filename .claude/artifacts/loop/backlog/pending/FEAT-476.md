---
id: FEAT-476
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-13
updated: 2026-07-13
depends_on: [FEAT-458]
slices: []
derived_from: .claude/artifacts/crew/handoffs/20260712T230000Z-feat458-waves-orchestrator-handoff.md
cross_product: [astramem-local]
autonomous_safe: null
triage_notes: "Filed 2026-07-13 during FEAT-458 S5. Not yet PM-scored. Sits directly on top of the proxy usage telemetry landed in FEAT-458 S5 — this FEAT is the READ side (pricing + attribution + reporting), deliberately separated from the CAPTURE side so that stored token counts stay immutable and dollar figures are always derived, never persisted."
---
## Description

**Agent-run cost attribution — turn tokens into dollars, and dollars into slices.**

FEAT-458's proxy capture fork extracts raw usage from the response body of every
LLM call it relays: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`, `stop_reason`, and the `model` id. Those are stored as
structured metadata on the captured envelope, in raw counts only — **FEAT-458
deliberately computes no dollar figures.**

This FEAT is the read side: a pricing table, a cost derivation, and a report that
answers the question the operator actually has — *"what did that feature cost me
to build, and where is the money going?"*

**Why this matters now:** the operator runs a fleet of agents (builders, reviewers,
architects, validators) through a crew/loop harness that already tracks cost per
slice — but from the harness's own accounting, which is an *estimate*. The proxy
sees what the provider actually billed. That is the difference between a guess and
a receipt.

The single highest-leverage signal is **prompt-cache efficiency**. Cache reads bill
at roughly 10% of the input rate; cache writes bill at roughly 125%. A long-context
slice that reads its cache versus one that re-creates it is an order-of-magnitude
cost difference *for identical work* — and today there is zero visibility into which
one is happening.

## Scope

### In scope

- **Pricing table in config**, not in code. Per-model input/output rates plus the
  cache multipliers, e.g.

  ```yaml
  pricing:
    "claude-sonnet-5":       { inputPerMTok: 3.00,  outputPerMTok: 15.00 }
    "claude-opus-4-8":       { inputPerMTok: 15.00, outputPerMTok: 75.00 }
    cacheReadMultiplier:     0.10   # cache reads bill at ~10% of input rate
    cacheWriteMultiplier:    1.25   # cache writes bill at ~125% of input rate
  ```

- **Cost derived at READ time, never persisted.** Stored token counts are immutable
  facts; prices are mutable opinions. When a price changes (or the table was wrong),
  re-deriving must correct all history rather than leaving a stratum of rows priced
  under a stale table. **Persisting a computed dollar amount alongside the counts is
  an explicit anti-goal.**

- **Attribution by slice / FEAT / agent role.** The join key already exists:
  captured envelopes carry `session_id` and `project_id`, and the loop harness
  stamps `currentRun` (the active SLICE id) into `.claude/state/`. The correlation is
  a lookup by session — **no new plumbing on the proxy hot path.**

- **A `cost` report/CLI surface.** Group by slice, FEAT, model, and agent role.
  Answer at minimum:
  - What did SLICE-NN / FEAT-NNN cost, in real billed dollars?
  - Which agent roles are expensive? (Is the reviewer fan-out worth its price?)
  - What is my cache hit ratio, and which slices are defeating the cache?
  - Where are replies being truncated (`stop_reason: max_tokens`)?

- **Doctor surface** for cache efficiency, since it is the actionable one.

### Out of scope

- Any change to the proxy capture path itself (FEAT-458 owns it, and it is closed).
- Billing, invoicing, quota enforcement, or spend limits.
- Cloud-side (astramem SaaS) cost attribution — same idea likely applies there, but
  it is a separate product and a separate FEAT.

## Acceptance criteria

- AC-1 — Given a captured proxy envelope carrying raw usage and a `model` id, when
  the cost report runs, then it derives a dollar figure from the config pricing table
  at read time, and no dollar figure is persisted anywhere in the store.

- AC-2 — Given the pricing table is edited (a rate corrected), when the cost report
  is re-run over the SAME historical envelopes, then every historical figure reflects
  the new rate. (This is the test that proves cost is derived, not stored.)

- AC-3 — Given an envelope whose usage is ABSENT (e.g. OpenAI streaming without
  `stream_options.include_usage`), when the report runs, then that turn is reported as
  *unknown cost* and is EXCLUDED from totals — it must never be silently counted as
  `$0`, which would under-report spend invisibly. A visible "N turns with unknown
  usage" count must appear in the report.

- AC-4 — Given a model id absent from the pricing table, when the report runs, then
  those turns are surfaced as *unpriced* with the model id named, and are excluded
  from totals rather than priced at zero or at a guessed default.

- AC-5 — Given captured turns from a session that the loop associated with SLICE-NN,
  when the cost report groups by slice, then those turns' cost is attributed to
  SLICE-NN.

- AC-6 — Given captured turns carrying `cache_read_input_tokens` and
  `cache_creation_input_tokens`, when the report runs, then cache reads and cache
  writes are reported as DISTINCT line items (never summed into one "cache" number),
  and a cache-hit ratio is derived.

- AC-7 — Given a turn with `stop_reason: "max_tokens"`, when the report runs, then it
  is counted and surfaced as a truncated reply.

## Risks and notes

- **The zero-vs-absent trap.** Fabricating `0` for missing usage would silently
  under-count spend forever, undetectably. FEAT-458 S5 pins absent-not-zero at the
  capture boundary; AC-3 pins it again at the report boundary. Both are deliberate.

- **Stale pricing tables rot silently.** A confidently-wrong dollar figure is worse
  than no figure. Hence: prices live in config (the operator can correct them), the
  table is versioned, and unpriced models are surfaced loudly rather than defaulted
  (AC-4).

- **Attribution depends on the loop's session→slice mapping** being present and
  correct. If a session was not run under a slice ceremony (e.g. an ad-hoc
  interactive session), its cost is real but unattributable — report it under an
  explicit "unattributed" bucket rather than dropping it.

- **Capture must be ON for any of this to work**, and capture is default-OFF and
  gated (ADR-013 / DEC-014). This FEAT produces nothing until the operator
  deliberately enables proxy capture. That is correct and should not be
  engineered around.

## Strategic note

astramem sells a memory API for AI agents. Cost + cache + tool-use telemetry per
agent turn is a second product through the same integration — every team running
agents is flying blind on exactly this, and knows it. Worth an explicit product
decision as to whether observability is the wedge rather than the accessory; the
proxy is already the tap for both.
