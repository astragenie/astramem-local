---
id: FEAT-477
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-13
updated: 2026-07-13
depends_on: [FEAT-458]
slices: []
derived_from: .claude/artifacts/crew/handoffs/20260712T230000Z-feat458-waves-orchestrator-handoff.md
cross_product: [astramem-local, astramem]
autonomous_safe: null
triage_notes: "Filed 2026-07-13 during FEAT-458 S5. This is arguably the highest-value thing the proxy unlocks — it is the only instrument that can independently measure whether astramem's recall actually works, because every existing signal is agent self-report. Live daemon on 2026-07-13 reports served=349, used=0, rate=0. Not yet PM-scored."
---
## Description

**Recall efficacy — measure whether served memories are actually USED, without asking the agent.**

astramem's recall-usefulness metric is currently broken in a way that makes it
useless as a product signal, and the breakage is structural, not a bug:

- `recall_served` fires reliably — one event per atom returned from a search
  (`src/storage/usefulness.ts:55`).
- `recall_used` fires **only when an agent voluntarily calls `mark_memory_used`**
  (MCP tool / `POST /memory/:id/used`) — `usefulness.ts:12-14`.

Agents essentially never self-report. Live daemon, 2026-07-13:

```
usefulness: { served_7d: 198, used_7d: 0, rate_7d: 0 }
memory_health.usefulness: { served: 349, used: 0, coverageRate: 0.027 }
```

**349 memories served. Zero ever marked used.**

That number has two completely opposite readings, and today we cannot tell which:

1. **Measurement bug** — recall works fine, agents simply don't call the tool.
2. **Product bug** — recall genuinely surfaces junk that no agent ever uses.

These point in opposite directions (one is a telemetry fix, the other is a
retrieval-quality emergency), and we are shipping a memory product without
knowing which one is true. Every existing signal is agent self-report, so no
amount of additional instrumentation on our own side can resolve it.

**The proxy resolves it.** FEAT-458's capture fork sees the *actual assembled
prompt* that reached the model, and the *actual reply* that came back. That is
ground truth, independent of whether the agent chooses to tell us anything.

## The measurement

For each recall event, three questions the proxy can answer that we currently cannot:

1. **Did the served memory even reach the prompt?** We know we returned it. We do
   NOT know whether the client actually injected it into the context window, or
   dropped it, truncated it, or buried it. The proxy sees the bytes that went out.

2. **Did the model's reply depend on it?** Attribution heuristics, in ascending
   cost/confidence order:
   - lexical overlap between the served atom and the reply (cheap, weak)
   - distinctive-token / n-gram match (a fact only present in the memory appearing
     in the reply is strong evidence)
   - LLM-judge attribution pass (expensive, strongest — use offline/sampled, never
     on the hot path)

3. **Was recall even needed?** If the reply is fully derivable from the rest of the
   prompt, a "used" memory may still be worthless. Distinguishing *present-and-used*
   from *present-and-load-bearing* is the difference between a vanity metric and a
   real one.

## Scope

### In scope

- Correlate `recall_served` events to captured proxy turns (join on `session_id` /
  `project_id`, already present on both sides — no new hot-path plumbing).
- Compute a **proxy-derived usefulness rate**, sitting ALONGSIDE the existing
  self-reported one — never silently replacing it. The gap between the two numbers
  is itself the finding: it quantifies exactly how much the self-report loop
  under-counts.
- Doctor surface + a report showing: served, reached-prompt, appeared-in-reply,
  and the derived rate.
- Sampled LLM-judge attribution, run offline against captured turns, opt-in.

### Out of scope

- Changing the retrieval algorithm. **Measure first.** Any retrieval tuning done
  before this instrument exists is tuning against a metric we know is broken.
- Removing or "fixing" `mark_memory_used`. Keep it; it is a useful explicit signal
  when it does fire. This FEAT adds an independent second signal, it does not
  replace the first.
- Cloud (astramem SaaS) parity — same idea applies and probably matters more there,
  but it is a separate product and a separate FEAT. Flagged in `cross_product`.

## Acceptance criteria

- AC-1 — Given a memory was served into a recall and proxy capture is ON, when the
  resulting LLM turn is captured, then the system can determine whether the served
  atom's text was present in the outgoing prompt.

- AC-2 — Given a served atom was present in the prompt, when the model's reply is
  captured, then the system produces an attribution verdict (used / not used) via
  at least the lexical + distinctive-token heuristics, with the heuristic named on
  the verdict so a weak signal is never presented as a strong one.

- AC-3 — Given both signals exist, when the usefulness report runs, then it shows
  the self-reported rate AND the proxy-derived rate side by side, and explicitly
  names the delta. (The delta is the deliverable — it is what tells us whether
  `used_7d: 0` was a measurement artifact or a product verdict.)

- AC-4 — Given proxy capture is OFF (the default), when the report runs, then it
  degrades cleanly: the proxy-derived rate is reported as *unavailable*, never as
  `0`. A fabricated zero here would recreate the exact bug this FEAT exists to fix.

- AC-5 — Given the LLM-judge attribution pass is enabled, when it runs, then it runs
  OFFLINE against already-captured turns — never in the request path, never adding
  latency to a forwarded call (ADR-013 Decision 2: capture must never backpressure
  the client-facing pipe).

- AC-6 — Given a served atom appeared in the prompt but the reply is fully derivable
  without it, when attribution runs, then the verdict distinguishes *present* from
  *load-bearing*, or explicitly records that it cannot — it must not silently score
  mere presence as usefulness.

## Risks and notes

- **This measures our own product and may return bad news.** That is the point. The
  instrument must be built so it CAN say "recall is not helping," or it is not an
  instrument. Do not tune the heuristics until the number looks good.

- **Requires proxy capture ON** (default-OFF, gated by ADR-013 / DEC-014). Produces
  nothing until the operator deliberately enables it. Correct; do not engineer around.

- **Privacy stays as-is.** Everything needed is body bytes already captured. **No
  headers, ever** — the structural header-exclusion invariant from FEAT-458 S3 is
  not negotiable and this FEAT must not become the reason to weaken it.

- **Attribution is a heuristic, not truth.** Lexical overlap will produce false
  positives (common words) and false negatives (the model paraphrased). Report
  confidence, and never present a weak heuristic's verdict as certainty. An
  over-confident usefulness number would be worse than the honest zero we have now.

## Why this is likely the highest-value thing the proxy unlocks

astramem's entire thesis is that memory makes agents better. The metric that would
demonstrate that thesis currently reads **zero**, and we cannot tell whether that is
because the thesis is unproven or because the thermometer is broken.

Cost attribution (FEAT-476) tells the operator about their bill. This tells them
about their business.
