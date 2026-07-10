# Task Handoff: Letta (letta-ai/letta) competitive intel — code-verified

- Created: 2026-07-09T20:49:35.814Z
- From: researcher
- To: dispatcher
- Objective: Confirmed letta is a full Python agent runtime (Apache-2.0, FastAPI+Postgres-only, self-editing LLM-driven memory) with a generated (Fern) TypeScript SDK and both MCP client + registration surface, but NO first-party MCP server exposing Letta itself; LoCoMo 83% benchmark is unverifiable from the repo (no mention anywhere in source/docs).
- Allowed Scope:
  - Read-only source inspection of shallow clone at C:\work\mega\astramem-local-competitors-code\letta across 11 dimensions: stack
  - storage
  - retrieval
  - memory lifecycle
  - provenance
  - local-first
  - security
  - eval rigor
  - MCP integration
  - license
  - traction.
- Forbidden Scope: -
- Deliverable: Dense file:line-cited findings per dimension, delivered inline to dispatcher (see chat transcript for full report). Not written to disk per no-report-files rule.
- Changed Files:
  - none (read-only)
- Confidence: high
- Risks: LoCoMo 83% claim could not be found anywhere in this clone (README, docs, code) — either it's from an external blog/marketing page not vendored here, or an older/different version. Star count and other GitHub traction metrics not verifiable offline. Did not check fern/ dir contents for TS SDK actual source (only confirmed CI workflow existence: fern-sdk-typescript-preview/publish.yml) — TS SDK is Fern-generated from OpenAPI, not hand-written in this repo.
- Suggested Next Handoff: If LoCoMo number matters for the competitive doc, dispatch a web-capable pass (WebFetch/WebSearch) against letta.com blog or the LoCoMo paper's leaderboard to find the actual source of the 83% claim before citing it as fact.

