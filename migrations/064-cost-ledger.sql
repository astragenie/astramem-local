-- 064: cost ledger — `cost_events` (facts) + `price_versions` (effective-
-- dated rates), FEAT-476 Phase 0.
--
-- Position (see .claude/artifacts/loop/backlog/pending/FEAT-476.md for the
-- full spec + adversarial-review rationale): dollar amounts are NEVER
-- stored as a column, on this table or anywhere else. `cost_events` records
-- ONLY facts — raw token counts, model, provider, timestamps, attribution
-- keys — independent of whether the transcript row itself survives the
-- relevance gate, gets redacted, or is purged (this table has its own
-- retention policy and is never touched by the transcript purge flow).
-- `price_versions` is effective-dated so a genuine historical price CHANGE
-- and a later data-entry CORRECTION to a past window are both
-- representable without conflating "what was billed at the time" with
-- "what we now believe the rate should have been" (AC-2).
--
-- cost_events
--   - `source`: 'proxy' (src/capture/proxy.ts tee, body-only visibility,
--     synthetic per-exchange session_id) or 'otel' (Claude Code's native
--     OTel export — real session.id/agent.name, the richer of the two;
--     preferred on dedup collision, AC-6).
--   - Every numeric usage column is NULLable and NULL means "not present in
--     the captured response" — NEVER coerced to 0 (AC-3: a fabricated zero
--     would silently corrupt any aggregation built on top). `model` is also
--     nullable for the same reason — an unrecognized response shape yields
--     no model at all, not a guessed one.
--   - `dedup_key` is UNIQUE — the join key across the two ingest paths
--     (AC-6). Computed as a hash of provider+model+time-bucket+token-counts
--     (see src/storage/cost-events.ts `computeDedupKey`), loosely time-
--     bucketed so the proxy's and OTel's independently-stamped captured_at
--     for the SAME physical exchange still collide.
--   - `slice_id`/`agent_role` are nullable and populated by the read-time
--     attribution join (src/storage/slice-attribution.ts) or, for
--     `agent_role`, directly from OTel's `agent.name` when the ingest
--     source actually carries it — proxy-sourced rows always have
--     `agent_role: null` (structural, not a bug: see FEAT-476 spec's
--     attribution-join-contract section).
CREATE TABLE cost_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('proxy','otel')),
  captured_at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NULL,
  input_tokens INTEGER NULL,
  output_tokens INTEGER NULL,
  cache_read_input_tokens INTEGER NULL,
  cache_creation_input_tokens INTEGER NULL,
  stop_reason TEXT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  session_key TEXT NOT NULL,
  slice_id TEXT NULL,
  agent_role TEXT NULL,
  dedup_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_cost_events_dedup_key ON cost_events(dedup_key);
CREATE INDEX idx_cost_events_captured_at ON cost_events(captured_at DESC);
CREATE INDEX idx_cost_events_model ON cost_events(model);
CREATE INDEX idx_cost_events_slice_id ON cost_events(slice_id);

-- price_versions
--   - `tier` distinguishes standard/priority/batch billing. IF a caller ever
--     queries with `tier: 'priority'` and no matching row exists, the query
--     correctly returns unpriced rather than silently falling back to
--     standard (per the FEAT-476 accuracy-trap checklist) — BUT review
--     finding 3 (2026-08): `cost_events` (above) has NO tier column at all
--     in Phase 0, because body-only proxy capture and Claude Code's
--     documented OTel schema neither one carries a service-tier signal.
--     Every call site in src/storage/cost-events.ts's `costReport`
--     therefore OMITS `tier` entirely, which defaults to `'standard'`
--     inside `findPriceVersion` — meaning a turn ACTUALLY billed at
--     Anthropic's Priority Tier or either provider's Batch API is priced AS
--     STANDARD, unconditionally, in Phase 0. This is the loud
--     acknowledgment: it is a real accuracy gap, not a theoretical one, and
--     `CostReport.tierAssumptionNote` surfaces it in every report's output
--     (not just here) so it can't be missed by not reading source comments.
--     The seeded `'batch'`-tier rows below are correct-and-ready but INERT
--     until a future slice adds real tier detection to the capture layer.
--   - `input_rate`/`output_rate` are USD PER SINGLE TOKEN (not per million)
--     — e.g. Anthropic Sonnet 5's published $2/MTok input becomes 0.000002
--     here — so the report's dollar derivation is a plain multiplication
--     with no /1e6 scaling step to get wrong.
--   - `cache_read_multiplier`/`cache_write_multiplier` apply to
--     `input_rate` (never `output_rate` — cache tokens are always input-
--     side). Anthropic: read 0.1x, write 1.25x (5-minute TTL) — see the
--     seed rows below for the 1-hour write variant, seeded as a `priority`-
--     tier-adjacent row is NOT modeled in Phase 0 (named gap: TTL-variant
--     cache writes collapse to the more common 5-minute multiplier).
--   - `model` is matched by PREFIX against `cost_events.model` (see
--     `findPriceVersion` in src/storage/cost-events.ts) — API model ids are
--     versioned strings (this environment's own model id convention: see
--     AGENTS.md-adjacent runtime context), so an exact-match-only design
--     would silently go stale on every point release. A model id matching
--     no price_versions prefix is surfaced unpriced (AC-4) — this is a
--     deliberate accuracy floor, not a bug: a wrong guess is worse than an
--     honest "we don't know this model's price" line.
--   - `source`: 'config' (a published-rate seed row, like the ones below)
--     or 'manual-correction' (AC-2's "we were wrong" case — a human fixed a
--     typo'd rate for a past window; see `correctPriceVersion` vs
--     `addPriceVersion` in the storage module for the two distinct write
--     paths this distinction protects).
CREATE TABLE price_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('standard','priority','batch')),
  effective_from INTEGER NOT NULL,
  effective_to INTEGER NULL,
  input_rate REAL NOT NULL,
  output_rate REAL NOT NULL,
  cache_read_multiplier REAL NOT NULL DEFAULT 1.0,
  cache_write_multiplier REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL CHECK (source IN ('config','manual-correction')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_price_versions_lookup ON price_versions(provider, model, tier, effective_from);

-- Seed rows: published rates as data, not code constants (FEAT-476 spec).
-- Source: https://platform.claude.com/docs/en/about-claude/pricing and
-- https://developers.openai.com/api/docs/pricing, both fetched 2026-08-06.
-- `effective_from` = 0 (Unix epoch) — Phase 0 does not attempt to backdate
-- genuine historical price CHANGES that predate this ledger's existence
-- (out of scope; the one-time transcripts.proxy_usage_json backfill script
-- is best-effort per the spec's Migration note). A real future price change
-- gets its OWN row with a real `effective_from` (AC-2), which is exactly
-- what proves the model distinguishes "we were wrong" from "the price
-- changed" — a seed row is never edited in place for that case, only for a
-- genuine data-entry correction (`source: 'manual-correction'`).
--
-- Model-id prefixes below follow this environment's own convention
-- (lowercase, hyphenated, no date suffix — see this session's own model id
-- `claude-sonnet-5`) and are matched by PREFIX at report time (see
-- `findPriceVersion`), so a real captured id like `claude-sonnet-5-20260815`
-- (if this provider ever adopts a date-suffixed scheme) still resolves.
-- Review finding 5: a BARE row like 'claude-opus-5' or 'gpt-5' is a prefix
-- of every dotted/suffixed sibling too (e.g. a hypothetical
-- 'claude-opus-5.1' or 'gpt-5-turbo') — it acts as an IMPLICIT WILDCARD for
-- any future model that happens to extend the string, not just a
-- date-suffix variant of the exact named model. Usually harmless (a sibling
-- model sharing a price is common), but a reviewer auditing a surprising
-- price match should know a bare prefix row is doing double duty, not
-- narrowly scoped to one model.
-- Anthropic cache multipliers: read 0.1x (10% of input), write 1.25x (the
-- 5-minute-TTL write price; the 1-hour-TTL 2x variant is a named Phase-0 gap
-- — see FEAT-476 spec's accuracy-trap checklist, "long-context repricing"
-- row). OpenAI cache multipliers: read ~0.1x; write premium (1.25x) applies
-- ONLY to the GPT-5.6 family per the FEAT-476 spec's own verified research
-- (kb/12-research/token-cost-monitoring-2026-08/stage2/raw/reconciliation-feasibility.md)
-- — pre-5.6 models have no separate cache-write charge at all, modeled here
-- as a 1.0x multiplier (cache-write tokens price identically to plain input
-- tokens, which is what "no write fee" means in practice).
INSERT INTO price_versions
  (provider, model, tier, effective_from, effective_to, input_rate, output_rate, cache_read_multiplier, cache_write_multiplier, source, created_at)
VALUES
  -- Anthropic — standard tier (input_rate/output_rate = USD per token)
  ('anthropic', 'claude-opus-5',    'standard', 0, NULL, 0.000005,  0.000025, 0.1, 1.25, 'config', 1785974400000),
  ('anthropic', 'claude-opus-4-8',  'standard', 0, NULL, 0.000005,  0.000025, 0.1, 1.25, 'config', 1785974400000),
  ('anthropic', 'claude-opus-4-7',  'standard', 0, NULL, 0.000005,  0.000025, 0.1, 1.25, 'config', 1785974400000),
  ('anthropic', 'claude-opus-4-6',  'standard', 0, NULL, 0.000005,  0.000025, 0.1, 1.25, 'config', 1785974400000),
  ('anthropic', 'claude-opus-4-5',  'standard', 0, NULL, 0.000005,  0.000025, 0.1, 1.25, 'config', 1785974400000),
  ('anthropic', 'claude-sonnet-5',  'standard', 0, NULL, 0.000002,  0.000010, 0.1, 1.25, 'config', 1785974400000),
  ('anthropic', 'claude-sonnet-4-6','standard', 0, NULL, 0.000003,  0.000015, 0.1, 1.25, 'config', 1785974400000),
  ('anthropic', 'claude-sonnet-4-5','standard', 0, NULL, 0.000003,  0.000015, 0.1, 1.25, 'config', 1785974400000),
  ('anthropic', 'claude-haiku-4-5', 'standard', 0, NULL, 0.000001,  0.000005, 0.1, 1.25, 'config', 1785974400000),
  ('anthropic', 'claude-haiku-3-5', 'standard', 0, NULL, 0.0000008, 0.000004, 0.1, 1.25, 'config', 1785974400000),
  -- Anthropic — batch tier (50% off both directions; no cache multipliers
  -- modeled for batch — Anthropic's batch API does not support prompt
  -- caching, so cache_read/write columns stay at the neutral 1.0 default
  -- and a batch-tier cache column populated by mistake is simply priced as
  -- plain input, never silently discounted twice).
  ('anthropic', 'claude-opus-5',    'batch', 0, NULL, 0.0000025, 0.0000125, 1.0, 1.0, 'config', 1785974400000),
  ('anthropic', 'claude-sonnet-5',  'batch', 0, NULL, 0.000001,  0.000005,  1.0, 1.0, 'config', 1785974400000),
  ('anthropic', 'claude-haiku-4-5', 'batch', 0, NULL, 0.0000005, 0.0000025, 1.0, 1.0, 'config', 1785974400000),
  -- OpenAI — standard tier. Review finding 5: these cache_read_multiplier /
  -- cache_write_multiplier values are currently DEAD DATA in practice —
  -- src/capture/proxy.ts's extractUsageMetadata only ever populates
  -- cache_read_input_tokens/cache_creation_input_tokens for Anthropic
  -- responses (see that function's own doc comment), so an OpenAI
  -- cost_events row's cache fields are always null and never reach these
  -- multipliers at report time. Correct-and-ready for whenever OpenAI cache
  -- extraction lands, not a bug today — kept as real published rates rather
  -- than removed, so no future OpenAI-cache slice has to re-research them.
  ('openai', 'gpt-5.6-sol',   'standard', 0, NULL, 0.000005,   0.00003,   0.1, 1.25, 'config', 1785974400000),
  ('openai', 'gpt-5.6-terra', 'standard', 0, NULL, 0.000002,   0.000012,  0.1, 1.25, 'config', 1785974400000),
  ('openai', 'gpt-5.6-luna',  'standard', 0, NULL, 0.0000002,  0.0000012, 0.1, 1.25, 'config', 1785974400000),
  ('openai', 'gpt-5',         'standard', 0, NULL, 0.00000125, 0.00001,   0.1, 1.0,  'config', 1785974400000),
  ('openai', 'gpt-5-mini',    'standard', 0, NULL, 0.00000025, 0.000002,  0.1, 1.0,  'config', 1785974400000),
  ('openai', 'gpt-4o',        'standard', 0, NULL, 0.0000025,  0.00001,   0.5, 1.0,  'config', 1785974400000),
  ('openai', 'gpt-4o-mini',   'standard', 0, NULL, 0.00000015, 0.0000006, 0.5, 1.0,  'config', 1785974400000),
  -- OpenAI — batch tier (50% off)
  ('openai', 'gpt-5.6-sol',   'batch', 0, NULL, 0.0000025,  0.000015,  1.0, 1.0, 'config', 1785974400000),
  ('openai', 'gpt-5',         'batch', 0, NULL, 0.000000625, 0.000005, 1.0, 1.0, 'config', 1785974400000),
  ('openai', 'gpt-4o',        'batch', 0, NULL, 0.00000125, 0.000005,  1.0, 1.0, 'config', 1785974400000);
