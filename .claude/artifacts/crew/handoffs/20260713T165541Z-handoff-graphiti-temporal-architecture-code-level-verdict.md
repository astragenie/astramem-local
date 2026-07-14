# Task Handoff: Graphiti temporal architecture — code-level verdict

- Created: 2026-07-13T16:55:41.377Z
- From: researcher
- To: dispatcher
- Objective: Graphiti's temporal capability is BOTH ontological (valid_at/invalid_at are first-class typed fields on EntityEdge) and implementation-heavy (LLM-driven contradiction detection, deterministic interval-comparison invalidation, mandatory Neo4j/FalkorDB + OpenAI at ingest).
- Allowed Scope:
  - Read graphiti_core/nodes.py
  - edges.py
  - utils/maintenance/edge_operations.py
  - prompts/dedupe_edges.py
  - search/search_filters.py
  - search/search_utils.py
  - graphiti.py add_episode
  - pyproject.toml
  - docker-compose.yml — no code changes made.
- Forbidden Scope: -
- Deliverable: 7-point evidence-dense findings report returned inline to dispatcher (not written to a file) covering: EntityEdge valid_at/invalid_at as typed fields, bitemporal valid-vs-system time separation, LLM+deterministic-rule contradiction/invalidation pipeline, opt-in Cypher interval filters at query time, mandatory Neo4j+OpenAI cost profile, structural expressiveness (episodes provenance list, CommunityNode, SagaNode), and honest weaknesses.
- Changed Files:
  - none (read-only)
- Confidence: high
- Risks: Did not trace FalkorDB/Kuzu driver-specific query variants in full depth, nor exact LLM call count variance across entity_types/edge_types configs — count given (4-6+ LLM calls/episode, scales with extracted node/edge count) is a floor from add_episode's call graph, not an exhaustive trace of every sub-path (community update, attribute extraction per edge type).
- Suggested Next Handoff: Feed this into the adversarial architecture comparison scoreboard document; if the stakeholder wants exact LLM-call-count benchmarks, dispatch a follow-up researcher run instrumenting add_episode with a call counter against a live Neo4j+OpenAI stack.

