# Doc Truth-Up — Wave Plan

*2026-07-13 · Reconciles all documentation with the findings in `docs/research/20260713-teardown-and-reinvent.md` (6-agent investigation) + `docs/specs/20260713-teardown-remediation-plan.md` (architect + architect-reviewer signed off).*

## Why this exists

The investigation produced **three classes of doc debt**:

1. **False claims in our own docs** — one of which I promoted to CONFIRMED and nearly shipped into a build (contradiction detection "off by default": it ships **`enabled`**).
2. **Unsafe external claims** — "45.4 F1 beats the paper's 41.4" is a **10% / one-conversation / n=199 sample** vs. the paper's full 1986-question set. This is circulating.
3. **Stale competitor claims** — the 2026-07-09 gap analysis predates findings that **overturn its premises** (mem0's write-time intelligence is dead code; mem0 paywalls temporal; supermemory's "graph engine" is a canvas renderer).

Plus a large **omission**: `src/cli/mcp-stdio.ts` ships a spawn-per-session, zero-daemon MCP mode and **CLAUDE.md never mentions it** — which is how a full-session investigation ended up proposing it as a radical redesign.

## Parallelism rule

**One file, one owner. No exceptions.** Waves are cut on **file-disjointness**, not topic. Two writers in one Markdown file is the single reliable way to produce a conflict, and doc-writers are Markdown-only (never source).

Everything within a wave runs in **one parallel dispatch block**.

---

## WAVE 1 — Truth-up the primary surfaces (4 writers, fully disjoint)

| Owner | File (exclusive) | Mandate |
|---|---|---|
| **W1-A** | `CLAUDE.md` | Current code state. **Biggest gap: `mcp-stdio`.** |
| **W1-B** | `docs/research/2026-07-09-competitor-gap-analysis.md` | Corrections block — the premises that flipped. |
| **W1-C** | `docs/research/20260713-locomo-cohort-scoreboard.md` *(NEW)* | The scoreboard + a comparability standard. |
| **W1-D** | `README.md` | User-facing claims: MCP surface, eval numbers, install modes. |

## WAVE 2 — Supersession + methodology (3 writers, disjoint; depends on W1-C existing)

| Owner | File (exclusive) | Mandate |
|---|---|---|
| **W2-E** | `docs/eval/locomo-methodology.md` | The comparability rules; the n=199 caveat as a hard gate on any published number. |
| **W2-F** | `docs/research/2026-07-08-astramem-ecosystem-report.md` + `docs/research/2026-07-08-supermemory-matrix.md` | Supersession banners. Both predate the code-verified findings. Same owner because both are pure "point at the newer doc" edits. |
| **W2-G** | `docs/adr/ADR-015-loud-failure-invariant.md` *(NEW)* | The one architectural lesson worth institutionalizing (below). |

## WAVE 3 — Verify (1 reviewer)

Cross-doc consistency sweep. **No number, claim, or file:line may contradict another doc.** Specifically hunt for the *next* `DEFAULT_*`-style trap: a doc citing a constant that isn't the live value.

---

## The through-line every writer must carry

**Do not merely delete wrong claims — say what replaced them, and why the mistake was possible.** A doc that quietly drops a false claim teaches nobody; the next session re-derives it.

**The lesson worth institutionalizing (ADR-015, W2-G):**

> **Success and silent failure must never be the same observable state.**
>
> A distill job whose model returns well-formed `{"atoms":[]}` **completes successfully**. A broken extraction model and a quiet week are indistinguishable — not at the Zod gate, not at the job queue, not at the poison counter (which only counts *failures*, and these never fail).
>
> The team has fixed this **twice by hand** (`relation_guard_drops`, `evidence_guard_drops`) without generalizing it. That is why the disease keeps recurring and why "built, wired, never invoked" is folklore here.
>
> **Invariant: any code path that can produce a zero must be able to distinguish a real zero from a broken one, and that distinction must be readable without a human present.**

---

## Facts to propagate (verified — cite these, don't re-derive)

**Code state (all verified against source this session):**
- **`src/cli/mcp-stdio.ts` ships a spawn-per-session MCP mode** — no instance lock, no worker, no timers, no daemon lifecycle. Exits when the host closes stdin. **Undocumented in CLAUDE.md.** In this mode the PID-reuse kill hazard **cannot fire**.
- `proxy/server.ts:349` **binds an HTTP listener** → the proxy structurally **requires** a long-lived daemon. The daemon is not optional; it is mandatory for proxy/capture, background jobs, and sync.
- **Contradiction detection ships `enabled`** (`config.ts:555`) — *not* `off`. `DEFAULT_CONTRADICTION_DETECTION` (`config.ts:715`) is a **governance-fallback constant**, applied only when an override fails validation. It caused the FEAT-482 incident (~245 sequential LLM calls on a metered endpoint, sole worker lane wedged 10+ min); a **dollar cap was tried and reverted** (`0b6b3f8` — every provider hardcodes `usage.usd: 0`, so a budget check can never trip); `maxPerRun` + `maxWallClockMs` are the live guards.
- **The qwen3 fix is a regex on the model NAME** (`/^qwen3/i`, `ollama.ts:31-37`), not capability detection. The config's own doc comment names **`deepseek-r1` as equally affected** — and it is not handled.
- **`llmChatProbe` never passes `json:true`** (`llm-chat-probe.ts:19-22`) — it does not exercise `format:json`, the exact shape that caused the qwen3 incident. A green probe is not evidence extraction works.
- **Doctor never runs automatically.** `serve.ts` has no import of `doctor/runner.ts`.
- **`checkMemoryHealth` is hardcoded `ok:true`** (`checks.ts:657-694`) — a 100% poison rate still reports OK.
- **Four tables have zero writers**: `evidence_guard_drops` (in-flight), and day-one `messages`, `artifacts`, `provider_state` — the last of which **the dashboard reads** (`dashboard.ts:245`): an always-empty widget.
- **Bitemporal storage and `as_of` retrieval are CORRECT** (`migrations/006-atom-v3.sql`, `search.ts:264-278`). The 12.4 temporal score is an **extraction** gap: `AtomSchema` has no atom-level `valid_at`/`invalid_at`, `InsertInput` has no `valid_to` param. **Do not let any doc imply the schema is at fault.**

**Competitors (code-verified, overturns the 2026-07-09 report):**
- **mem0's write-time intelligence is DEAD CODE.** The ADD/UPDATE/DELETE memory-manager prompt (`prompts.py:176`) has **zero callers** outside its own unit test — in **both** the Python and TS SDKs. The real ingest path's system prompt says *"Your sole operation is ADD."* Dedup is **MD5 equality on exact text**. They abandoned it deliberately and claim **+21 LoCoMo points** for it. **The market leader converged on the append-and-rank-at-read shape astramem already has.**
- **mem0 paywalls temporal reasoning in OSS**: `add(timestamp=…)` **raises `ValueError`**. A 1,582-line `notices.py` detects free-tier temporal usage and fires upsell nudges. **The one capability explaining their LoCoMo lead is the one thing OSS users cannot test.**
- **Supermemory's "embedded graph engine" is a canvas renderer** (d3-force physics, viewport, input handler) — presentation, not a graph DB. The real backend is closed-source.
- **Graphiti's temporal advantage is at the EXTRACTION stage** (`_extract_edge_timestamps`, `edge_operations.py:576-620`) — the identical mechanism astramem needs. **It is not an ontology advantage.** Its costs: Neo4j + OpenAI as **non-optional base dependencies**, no offline mode, 4–6+ LLM calls per episode, and its temporal query filter is **opt-in, not a safe default**.
- **Zep's LoCoMo claims appear NOWHERE in their own arXiv paper (2501.13956)** — every one traces to a blog post they later edited, amid an active public dispute with mem0 over the numbers.
- **LoCoMo's ground truth has 99 corrupted labels in 1,540 questions (6.4%)**, and the standard LLM judge **accepts 62.81% of intentionally wrong-but-topical answers.** This discredits every judge-scored number in the cohort — and makes astramem's deterministic token-F1 + CI-gated floors a **real, unused asset**.

**The claim to freeze:** **stop publishing "45.4 F1."** It is n=199, one conversation, 10% sample (`20260713-locomo-score-plan.md:8-9,136`, which itself says *"full-sample rerun required"*). The 41.4 it "beats" is full-dataset. Same metric, **not** the same sample.
