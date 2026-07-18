# Task Handoff: Architect pre-build review: 20260716 local-LLM quality wave plan

- Created: 2026-07-16T14:12:38.846Z
- From: lead-session
- To: -
- Objective: FEAT-534 seam confirmed sound (scope gap: providers/index.ts + pipeline/handlers/distill.ts missing from hot-file list); FEAT-533 needs a spec correction (per-chunk batching unimplementable post-reduce, fix = job-level fixed-size batching); #370 diagnosis confirmed and recurs on every reinstall not just first-install, TimeTrigger fix recommended over schedule-type; #372 pagination belongs in ProposalRepo.list(); #352B needs a new governed 8th fusion term plus new search.ts data plumbing, not just fuse.ts math. No wave re-shuffle required.
- Allowed Scope: -
- Forbidden Scope: -
- Deliverable: -
- Changed Files:
  - docs/architecture/reviews/20260716-wave-plan-local-llm-quality-review.md
- Confidence: high
- Risks: verifier: none (review doc, not ADR/OpenAPI/Mermaid — no matching artifact-specific verifier). #352B section (item 5) is less exhaustively verified than items 1-4: fuse.ts governance shape and the missing search.ts supersession field are confirmed, but the exact recall-payload wiring point for the new field was not read line-by-line.
- Suggested Next Handoff: Lead: fold the FEAT-534 hot-file additions and FEAT-533 batching-granularity correction into the FEAT specs before W1/W2 builders start. W1-D (#352B) builder should locate the exact fuseHits() metas-building query in search.ts and the recall payload shape before implementing the new term.

