/**
 * Canonical content-hash helper (astramem-local#84).
 *
 * Single source of truth for the sha256 hex digest used as the `memories`
 * dedup key (`memories.hash`, UNIQUE index) and mirrored into
 * `memory_events.content_hash` (ADR-002). Always the FULL 64-character hex
 * digest -- the daemon's own sync-envelope.v1 schema requires
 * `content_hash` to match `^[a-f0-9]{64}$` (contracts/schemas/sync-envelope.v1.schema.json),
 * and shipping anything shorter forced a cloud-side constraint relax
 * (astragenie/memory#619, #620) to tolerate a daemon that violated its own
 * wire contract.
 *
 * Three call sites -- POST /remember (src/server/routes/search.ts), the MCP
 * `remember` tool (src/mcp/server.ts), and the Anthropic memory-tool adapter
 * (src/memory-tool/adapter.ts, create/insert + str_replace) -- used to
 * truncate this digest to the first 32 hex characters inline before this
 * helper existed. All three now call this function instead of hashing
 * inline, so no call site can drift back to a truncated or differently-
 * shaped hash. (The distill pipeline's own hash -- stage 6 `reduce.ts` /
 * stage 7 `memory-normalize.ts` `computeHash` -- already produced the full
 * 64-char digest and is intentionally left as its own function: it hashes
 * NORMALIZED text, a different input basis, not just a different length.
 * Unifying that input-basis difference is out of scope for #84, which is
 * specifically about digest LENGTH.)
 *
 * migrations/015-canonical-content-hash.sql recomputes existing 32-char rows
 * to the full 64-char digest for already-persisted data; see that file's
 * header comment for the dedup-safety argument.
 */

import { createHash } from 'node:crypto';

/** Full 64-character lowercase-hex sha256 digest of `text`. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
