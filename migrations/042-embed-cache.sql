-- 042: content-hash embedding cache (FEAT-492).
--
-- Local re-embeds identical content from scratch on every distill/reembed
-- run — Ollama has zero request cost (it's the user's own GPU/CPU), but it
-- is not zero TIME, and re-indexing unchanged content is pure waste. Ports
-- cloud's CachingEmbeddingProvider pattern (astramemory/memory
-- CachingEmbeddingProvider.cs): key = (content hash, model, dim), so a
-- model swap OR a configured-dim change (e.g. Azure `dimensions` truncation
-- on the same model name) can never serve a wrong-shape cached vector back
-- to a caller expecting `embed.dim`-length output.
--
-- Scoped to DOCUMENT-role embeds only (arch review 2026-07-14) — wired at
-- the call sites that embed content for storage (src/pipeline/handlers/
-- distill.ts, distill-events.ts via 08-embed-index.ts, and reembed.ts), NOT
-- at the shared raw provider query-role callers use (src/search/search.ts,
-- MCP/HTTP search routes) or the doctor/preflight probe. See
-- src/providers/embed/cache.ts's doc comment for the full role-scoping
-- rationale.
--
-- Size cap: enforced in application code (src/storage/embed-cache.ts's
-- evictExcess), not a DB trigger — simplest correct place to reason about
-- "count rows, delete oldest N by last_used_at" without fighting SQLite
-- trigger recursion rules. No TTL: a content hash's embedding never goes
-- stale (same text + same model always produces the same vector), so
-- eviction is purely about bounding disk/row count, not correctness.
CREATE TABLE IF NOT EXISTS embed_cache (
  content_hash TEXT NOT NULL,
  model        TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  vector       BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (content_hash, model, dim)
);

-- LRU eviction scan order.
CREATE INDEX IF NOT EXISTS idx_embed_cache_last_used ON embed_cache (last_used_at);

-- Single-row cumulative hit/miss counters (doctor "Embed cache hit rate"
-- stat, src/doctor/checks/embed-cache.ts). Cumulative since first use, not
-- windowed — a hit rate that resets on every daemon restart would read
-- artificially low right after every deploy/restart, the same "straddled
-- window" misread issue #200's postmortem already documents for a
-- calendar-time rate (see migrations/037's sibling doc, entity-link-rate.ts).
CREATE TABLE IF NOT EXISTS embed_cache_stats (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  hits       INTEGER NOT NULL DEFAULT 0,
  misses     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO embed_cache_stats (id, hits, misses, updated_at) VALUES (1, 0, 0, strftime('%s','now') * 1000);
