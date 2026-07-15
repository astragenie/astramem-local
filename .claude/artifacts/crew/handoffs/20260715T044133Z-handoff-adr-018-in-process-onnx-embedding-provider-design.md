# Task Handoff: ADR-018: in-process ONNX embedding provider design

- Created: 2026-07-15T04:41:33.539Z
- From: lead-session
- To: -
- Objective: Designed opt-in in-process ONNX Runtime (CPU EP) EmbedProvider to offload mxbai-embed-large VRAM from Ollama to CPU, freeing headroom for extraction on the 8151 MiB card; geometry-parity risk (cosine-sim pre-gate + retrieval-eval floor gate) is the explicit go/no-go, not an assumption.
- Allowed Scope: -
- Forbidden Scope: -
- Deliverable: -
- Changed Files:
  - docs/adr/ADR-018-onnx-embedding-provider.md
- Confidence: medium
- Risks: verifier: unavailable (validate-adr-template.ts not present in this repo/plugin cache -- advisory step skipped, not blocking). Confidence is medium-not-high specifically because the ADR's central factual premise (a maintained ONNX export of mxbai-embed-large-v1 exists and reproduces Ollama's output closely enough) is unverified from this design session (no web access) -- it is deliberately made SLICE-1's first blocking acceptance criterion with a named fallback chain (self-convert via optimum-cli) rather than assumed true.
- Suggested Next Handoff: Dispatch to fullstack-dev for SLICE-1 (provider skeleton + Risk-A artifact resolution + unit tests). Do NOT skip the Risk-A investigation to save time -- it gates every downstream slice.

