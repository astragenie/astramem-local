# Task Handoff: json:true call-site audit for array-vs-object shape defect (issue #261 class)

- Created: 2026-07-14T00:38:08.808Z
- From: researcher
- To: dispatcher
- Objective: Only decompose.ts asked for a bare top-level JSON array; all other json:true call sites already ask for a top-level object and validate it with Zod safeParse, so none of them are vulnerable to the same defect.
- Allowed Scope:
  - All json:true call sites to LLMProvider.chat() under src/: search/decompose.ts
  - src/entity/extract-entities.ts
  - src/distill/stages/05-extract.ts
  - src/consolidate/contradiction-judge.ts
  - src/tag-hygiene/tier2-infer.ts. Provider-layer files (ollama.ts
  - contracts/llm.ts
  - openai-compatible.ts
  - azure-openai.ts
  - mock-providers.ts) were identified but excluded as mechanism
  - not call sites.
- Forbidden Scope: -
- Deliverable: Inline findings report (below) covering shape asked-for vs shape parsed, and silent-vs-loud failure mode, per call site.
- Changed Files:
  - src/search/decompose.ts
  - src/entity/extract-entities.ts
  - src/distill/stages/05-extract.ts
  - src/consolidate/contradiction-judge.ts
  - src/tag-hygiene/tier2-infer.ts
- Confidence: high
- Risks: tier2-infer.ts's Tier2ResponseSchema and prompt text were not fully read (grep omitted a long line at :38) — worth a quick look if tier2-infer becomes a fix target, though the visible Zod object schema + safeParse pattern strongly suggests it is protected like the others.
- Suggested Next Handoff: None required — no other call site needs the decompose.ts-style fix. If tightening is desired anyway, tier2-infer.ts's parseTier2Response (line 73) and extract-entities.ts's tryParseEntities both do manual indexOf('{')/indexOf('}') brace-slicing before JSON.parse rather than a straight JSON.parse, which is a minor robustness question distinct from the array/object shape defect.

