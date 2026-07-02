# ADR-007: Extension Surface — MCP-first, narrow SDK, the Anthropic memory-tool adapter

**Status:** accepted · **Date:** 2026-07-02 · **Confidence:** High
**Context:** Surfaces today: HTTP (7 routes), CLI, MCP (4 tools). Verified fact (2026-07-02
sweep, 3–0): Anthropic's memory tool is client-side by design — developers subclass
`BetaAbstractMemoryTool` and provide storage. Strategy: occupy that socket. C1 says every
public surface is a permanent support cost.

## Decision

**Priority-ordered surfaces:**

1. **MCP (primary).** The native integration path for every agent tool that matters. Grow the
   tool set deliberately: `search_memory`, `recall_memory`, `remember`, `get_health` (existing) +
   `invalidate_memory`, `promote_memory` (scope, ADR-009), `memory_history` (supersession chain).
   Contract-versioned alongside `astramem/atom@1`.
2. **Anthropic memory-tool backend adapter (NEW, high priority, small).** A thin package
   implementing the Claude memory-tool contract (`BetaAbstractMemoryTool` shape) backed by the
   daemon's HTTP API. Any Claude API agent gets astramem as its memory backend with one import.
   Verified-open socket; converts platform risk into platform distribution. This is the highest
   leverage-per-line-of-code item in the architecture.
3. **CLI.** Human/dev ergonomics + service management (exists; un-stub `queue|rebuild|providers`).
4. **REST (minimal, frozen).** The 7 existing routes + sync capabilities. No public REST
   expansion in v1 — REST growth is how solo-maintained daemons die.
5. **gRPC: rejected.** No consumer, no requirement; revisit only if a partner demands it.

**Plugin SDK scope (narrow by design):** exactly two extension types —
- **Capture connectors:** new ingestion sources speaking the ADR-008 capture envelope.
- **Custom extractors:** new atom types registered into the ADR-001 type registry.
No third-party code execution inside the daemon in v1: connectors run out-of-process (they POST
to the ingest API); extractors ship via an allowlisted registry. Sandboxing third-party plugins
is deferred until there are third parties (C1; threat model ADR-009).

## Options considered

1. **MCP-first + memory-tool adapter + narrow SDK (chosen).**
2. **Rich in-process plugin platform (hooks/events everywhere).** Rejected: the master-prompt's
   own over-engineering; framework cost against C1, supply-chain surface against ADR-009, zero
   current demand.
3. **API-first REST platform.** Rejected: that's the generic-memory-API product we killed (2/10).

## Consequences & migration

- The memory-tool adapter ships as its own small repo/package (it's also marketing: the README
  is "give Claude persistent memory in 5 lines").
- MCP tool additions ride the atom v3 migration (they expose invalidation/scope/history).
- SDK docs: one page per extension type, examples in-repo; the narrowness is a feature — state
  it plainly ("we keep the core small so it keeps working").
