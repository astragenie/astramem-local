# Design — Wave 1/2 Amendments + Killer Features A/B/C

**Date:** 2026-07-02 · **Status:** approved direction (Approach 1: plan + amendments)
**Amends:** `docs/architecture/migration-map.md` (does not replace it — Waves 1–4 sequencing stands)
**Origin:** independent fresh-eyes review of v0.3.4 code + tooling (verdict: approach and stack confirmed,
no rebuild) + killer-feature design session. Strategy grounding: pass-3 P1/P4, playbook §4.

---

## 1. Decision

Execute the migration map as written, with three review amendments and three killer features
inserted into Waves 1–2 so the public launch (2f) ships **visible** differentiation:

| Id | Item | Wave | Effort |
|---|---|---|---|
| AM-1 | Persist provenance: `evidence` + atom-level schema thread-through | **1** (schema before data) | S |
| AM-2 | Fix fusion normalization edge case (all-equal scores → zeros) | 1 | XS |
| AM-3 | Fix `DAEMON_VERSION` drift (hardcoded 0.1.4 vs package 0.3.4) | 1 | XS |
| KF-A | `why_memory` — provenance receipts tool | 1 (ships v0.4.0) | S |
| KF-B | Proactive memory-pack injection (Claude Code hook + `/recall/pack`) | 2, pre-launch | M |
| KF-C | Session digest — "what I learned this session" | 2 | S |

Constraint C3 holds: every item independently shippable; nothing blocks Wave 1a (cipher spike)
or the 90-day plan. KF-B is the **launch headline**.

## 2. Review amendments

### AM-1 — Persist provenance (the dropped-evidence bug)

**Finding:** `AtomSchema` (stage 5) extracts `evidence?: string`, but `NormalizedMemory` →
`MemoryRepo.insert` (stage 8) drops it; `memories` has no evidence column. Pass-3 P4 names
provenance the cheapest differentiator — the pipeline already pays for it, then discards it.

**Change:**
- Migration `004-provenance.sql`:
  `ALTER TABLE memories ADD COLUMN evidence TEXT;` (nullable — old rows stay null)
- Thread `evidence` through stages 6 (reduce keeps the highest-confidence atom's evidence),
  7 (`NormalizedMemory.evidence`), 8 (insert it).
- `source_ref` is NOT a new column: `session_id` + `source_hash` already link to
  `sessions`/`transcripts` — the receipt chain uses them.

**Why Wave 1:** schema decisions before data accumulates; retrofitting evidence later = null
history forever.

### AM-2 — Fusion normalization edge case

**Finding:** `normalizeScores` returns all-zeros when `range === 0` — a single-hit FTS result
loses its entire BM25 signal; N equal-scored hits all lose the component.

**Change:** when `range === 0` and the list is non-empty, return all `1.0` (equal scores =
equally best within that component; relative ranking unaffected, signal preserved).
Unit tests: single hit, all-equal multi-hit, normal spread.

### AM-3 — Version drift

**Change:** `src/mcp/server.ts` derives `DAEMON_VERSION` from `package.json` (build-time import
or generated version module) instead of the hardcoded `'0.1.4'`. One source of truth.

## 3. KF-A — `why_memory` (provenance receipts)

**Product promise:** *every memory carries its receipts.*

- **Surface:** MCP tool `why_memory({ id })` + REST `GET /memory/:id/why`.
- **Returns:** `{ id, type, text, importance, confidence, evidence, session: { id, repo, branch, agent, started_at }, transcript_ref: source_hash, created_at }`.
- **Data flow:** `memories` row → join `sessions` on `session_id` → `source_hash` names the
  ingest payload. No new state; read-only composition over AM-1.
- **Errors:** unknown id → MCP error content (not throw); memory with null session → receipt
  without session block (pre-AM-1 rows degrade gracefully).
- **Forward-compatible:** when Atom v3 (Wave 2a) adds supersession, the same tool appends the
  `superseded_by`/`derived_from` chain. Tool contract designed for that now (array field
  `history`, empty in v1).
- **Test:** insert via pipeline with evidence → `why_memory` returns receipt; null-evidence row
  → receipt without evidence; unknown id → error.

## 4. KF-B — Proactive memory-pack injection (launch headline)

**Product moment:** open Claude Code in a repo — the agent already knows the repo's decisions,
lessons, and commands. Nobody asked. That is the P1 "injection judgment" made visible; the
answer to "long context kills memory."

**Components:**
1. **Daemon endpoint `POST /recall/pack`** — body `{ repo, project?, branch?, budget_tokens? }`.
   Selection heuristic v1 (no ML): filter `repo` match → score `w_type · w_recency · importance`
   (type weights: decision 1.0, lesson 0.9, fact 0.7, command 0.6, note/todo/event 0.4) →
   take top-N until `budget_tokens` (default 1500, estimate 4 chars/token) → group by type →
   render compact Markdown pack with memory ids.
2. **Claude Code hook (SessionStart)** — small shipped script (`hooks/memory-pack.md` install
   doc + script): calls the endpoint with cwd-derived repo, prints pack as additionalContext.
   Degrades silently (daemon down → empty output, never blocks the session).
3. **Config** — `config.recallPack: { enabled, budgetTokens, typeWeights }`. Off by default in
   v1 until launch; `astramem-local init` offers to install the hook.

**Explicitly deferred (YAGNI):** learned policy (needs 2e usefulness signal), per-prompt
UserPromptSubmit injection (needs latency budget + relevance gating), cross-repo packs.

**Errors:** endpoint returns 200 with empty pack on zero matches; hook timeout 2s hard cap.
**Test:** seeded repo memories → pack respects budget, ordering, type grouping; empty repo →
empty pack; budget smaller than one memory → single best memory.

## 5. KF-C — Session digest ("what I learned")

**Product moment:** session ends → 5 lines: `3 decisions, 2 lessons captured — [texts]`.
Makes the flywheel visible; builds the retention habit.

- **Storage:** distill handler already computes `PipelineResult`; persist per-job digest:
  `artifacts` row (`kind='digest'`, JSON: counts + created memory ids/texts). No schema change.
- **Surfaces:** REST `GET /sessions/:id/digest` (latest digest for session) + MCP tool
  `session_digest({ session_id? })` (default: most recent session for cwd repo) + Claude Code
  Stop-hook variant printing it (same install doc as KF-B).
- **Errors:** no digest yet (distill still queued/running) → `{ status: 'pending' }`;
  unknown session → error content.
- **Test:** ingest → digest artifact written; digest tool returns counts matching
  `PipelineResult`; pending job → pending status.

## 6. What does NOT change

- Wave 1a cipher × sqlite-vec spike remains the first action; AM/KF items do not gate it.
- Stack: better-sqlite3 + sqlite-vec + FTS5, Fastify, MCP SDK, zod, pino — confirmed, unchanged.
- Refuse-to-build list, kill condition, 90-day gate — carried unchanged.
- Wave 2a Atom v3 (bitemporal/scope/derived_from) unchanged — AM-1 is additive to it.

## 7. Sequencing within the plan

```
Wave 1:  1a spike → 1b/1c/1d encryption+redaction → 1e defect fixes
         + AM-1 (004 migration, ride the same release) + AM-2 + AM-3 + KF-A        → v0.4.0
Wave 2:  2a atom v3 → 2b events → 2c MCP lifecycle tools
         + KF-C (digest) → KF-B (recall pack + hook)                                → v0.5.0
         2d runner-plugin adapter → 2e usefulness metric → 2f LAUNCH (headline: KF-B)
```

## 8. Testing strategy

Unit: fuse edge cases (AM-2), pack selection/budget (KF-B), digest artifact (KF-C).
Integration: pipeline e2e with evidence → why_memory receipt (AM-1 + KF-A).
Contract: MCP tool schemas for `why_memory`, `session_digest` snapshot-tested.
All existing 52 test files must stay green — amendments are additive.
