# Task Handoff: mem0ai/mem0 competitive intel — code-verified

- Created: 2026-07-09T20:49:50.255Z
- From: researcher
- To: dispatcher
- Objective: mem0 has a real update/delete history log (refutes 'no provenance') and a search-time score explain path, but graph memory is fully absent from OSS (not just paywalled) and default config requires OpenAI (not local-first).
- Allowed Scope:
  - Static code investigation of shallow clone at C:\work\mega\astramem-local-competitors-code\mem0
  - 11 dimensions (stack
  - storage
  - retrieval
  - lifecycle
  - provenance
  - local-first
  - security
  - eval
  - MCP
  - license
  - traction). No web access
  - no file edits.
- Forbidden Scope: -
- Deliverable: Dense per-dimension findings with file:line citations returned inline to dispatcher (see chat transcript for full report); prior-report claims explicitly refuted/refined below.
- Changed Files:
  - none (read-only)
- Confidence: high
- Risks: Star count / traction not verifiable offline (no WebFetch). LoCoMo 92.5 number confirmed platform-only from README's own text but not independently reproduced. Graph memory absence confirmed via grep across .py files only — did not exhaustively check mem0-ts (TS SDK) or openmemory/ subpackage for a separate graph implementation.
- Suggested Next Handoff: If graph-memory or provenance claims feed a competitive-positioning doc, also check mem0-ts/ (Node SDK) for parity, since astramem-local is itself TS-based and that comparison may be more apples-to-apples than the Python SDK.

