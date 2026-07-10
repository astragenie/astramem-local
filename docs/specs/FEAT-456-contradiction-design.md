# FEAT-456: Contradiction Detection (Propose-Only v1) — Design

**Status:** proposed
**Date:** 2026-07-09
**Origin:** `.claude/artifacts/loop/backlog/triaged/FEAT-456.md` (rewritten 2026-07-09 after an
architecture-review blocker on the original design). Governing constraint: ADR-004 stage 9(c)
(`docs/adr/ADR-004-formation-pipeline.md:27-28`) — contradiction handling is **propose-only**;
auto-invalidation is trust-destroying (strategy Pass 6 A4).

## 0. Framing

`ConsolidationProposal.kind` already includes `'contradiction'`
(`src/consolidate/proposals.ts:14`) but nothing has ever produced one. This design wires a judge
into the existing pairwise cosine scan (`src/consolidate/consolidate.ts:303-390`,
`runConsolidation`) so it does. **v1 never mutates a memory directly** — the only write is a
`pending` row in `consolidation_proposals`, resolved exactly like a `'merge'` proposal is today
(REST, MCP, dashboard — all already generic over `kind`).

Scope of this design is **local-only** (astramem-local). Cloud mirroring is explicitly deferred —
see §5.

---

## 1. Detection stage

### 1.1 Hook point

Same group, same loop, same `(repo, type)` pairing `consolidate.ts` already does. No new
plumbing. One new branch is inserted into the existing double loop
(`consolidate.ts:322-390`), immediately before the existing `if (sim < proposeThreshold) continue;`
guard:

```
for i, j in group:                                   // unchanged
  if invalidatedThisRun has a or b: continue          // unchanged
  sim = cosine(va, vb)                                // unchanged, already computed for every pair

  // NEW — only when contradictionDetection.mode != 'off'
  if mode != 'off'
     and sim >= minSimilarity            // wider floor than proposeThreshold, see 1.2
     and sim <  mergeThreshold           // never judge a pair the merge tier already owns
     and judgeCallsThisRun < maxPerRun:  // per-run cost cap
    judgeCallsThisRun++
    verdict = await judgeContradiction(extractionProvider, a, b)   // §1.3
    if verdict.verdict == 'contradicts' and verdict.confidence >= minConfidence:
      [newer, older] = a.created_at >= b.created_at ? [a, b] : [b, a]
      if mode == 'dry-run':
        summary.contradictionsPreviewed.push({winner: newer.id, loser: older.id, sim, verdict})
      else:
        insertContradictionProposal(newer, older, sim, verdict)    // §2, same dedup guard as merge
      continue                                          // pair fully handled either way
    if verdict.verdict == 'unrelated':
      continue                                          // judge overrides: not actually a candidate

    // verdict is 'agrees' | 'refines' | ('contradicts' but low-confidence) —
    // fall through unchanged into the existing merge-tier logic below.

  if sim < proposeThreshold: continue                   // unchanged
  ... existing containment / mergeThreshold / propose-tier insert, byte-identical ...
```

Why this shape:
- **No pair is judged twice, no proposal kind collides.** A pair that resolves to `contradicts`
  (confident) is fully handled by the new branch and never reaches the existing merge-proposal
  insert. A pair the judge calls `agrees`/`refines` (or an unconfident `contradicts`) falls through
  to today's unchanged similarity-threshold logic — the judge never *blocks* a merge detection, it
  only *redirects* pairs it's confident are actually a conflict.
- **`unrelated` is new information the merge-tier scan doesn't have today**: a same-`(repo,type)`,
  high-cosine pair the judge says isn't actually about the same fact is skipped entirely instead of
  becoming a merge proposal — a quality improvement, not just an addition.
- **Cap degrades gracefully.** Once `maxPerRun` is spent, remaining band-eligible pairs simply fall
  through with no verdict, i.e. exactly today's merge-tier classification. A cheap corpus never
  errors or stalls because of the cap.

### 1.2 Similarity band

`proposeThreshold` (default 0.85) / `mergeThreshold` (default 0.92) are tuned for *near-duplicate
paraphrase* detection, not contradiction. Two contradicting facts about the same entity ("port is
7777" vs "port is 8888") can sit well below 0.85 cosine while still being exactly the kind of
conflict this feature exists to catch. So the judge's floor is a **new, separate, lower** config
value — `minSimilarity` (default **0.6**) — decoupled from `proposeThreshold`:

- `[minSimilarity, mergeThreshold)` — the full judge-eligible band (0.6–0.92 by default). This
  **includes** today's propose-tier sub-band (0.85–0.92), which is why the branch must sit ahead
  of the `proposeThreshold` guard, not behind it.
- `sim >= mergeThreshold` is never judged — the merge tier already treats it as certain enough to
  auto-supersede; contradiction detection only has anything useful to say about ambiguous pairs.

No new cosine computation is added — `sim` is already computed unconditionally for every pair in
the group (`consolidate.ts:328`); widening the floor only widens which *already-computed* pairs are
judge-eligible. Wall-clock/cost is bounded by `maxPerRun`, not by group size.

### 1.3 Judge

New pure module `src/consolidate/contradiction-judge.ts`:

```ts
export interface JudgeVerdict {
  verdict: 'agrees' | 'refines' | 'contradicts' | 'unrelated';
  confidence: number; // 0..1
}

export async function judgeContradiction(
  llm: LLMProvider,
  a: { text: string; created_at: number },
  b: { text: string; created_at: number },
): Promise<JudgeVerdict>
```

- **Provider:** reuses `ProviderSet.llm.extraction` (the same provider already used for structured
  JSON extraction, stage 5) — no new `llm.judge` config surface. This matches the FEAT body's own
  instruction and keeps the 2-role `ProviderSet` shape unchanged.
- **Call:** `llm.chat(messages, { temperature: 0, json: true })`, single pair per call (batching
  pairs into one call would save round-trips but makes parse-failure blast radius and eval-fixture
  labeling much messier for v1 — not worth it at `maxPerRun` scale).
- **System prompt** (sketch — exact wording finalized in slice 1, but must embed a stable marker
  constant, see §4):
  ```
  astramem-contradiction-judge-v1. You are comparing two memory statements about the same
  entity/topic to decide their relationship. Respond with a single JSON object:
  {"verdict": "agrees"|"refines"|"contradicts"|"unrelated", "confidence": <0..1>}.
  agrees = same fact, different wording. refines = B adds detail to A without conflicting.
  contradicts = A and B cannot both be true as stated. unrelated = not actually about the
  same fact despite similar wording.
  ```
- **User content:** `Statement A (${a.created_at}): ${a.text}\nStatement B (${b.created_at}): ${b.text}`
- **Parse:** strict Zod schema (`z.object({ verdict: z.enum([...]), confidence: z.number().min(0).max(1) })`).
  Parse failure or a thrown/rejected `chat()` call → treated as `{ verdict: 'unrelated', confidence: 0 }`
  (never fatal — matches the "never block a run on a bad LLM response" pattern already used by
  `estimateLlmJudgedJunk`, `src/server/queries/memory-health-deep.ts:280-290`, and the config-value
  governance pattern in `resolveAutoAcceptThreshold`). Logged via the same injectable `log` seam
  `runConsolidation` already takes.

### 1.4 `runConsolidation` becomes async

**Breaking-but-cheap signature change:** `runConsolidation` is documented today as deliberately
synchronous ("v1 is deterministic ... no LLM call", `consolidate.ts:22`). Adding a judge call means
it must become `async (...): Promise<ConsolidateSummary>`. Blast radius is small because both
existing call sites are already `async` functions and only need an `await` added:
- `src/pipeline/handlers/consolidate.ts:21` (`consolidateHandler.handle`, already `async`)
- `src/server/routes/consolidation.ts:47` (`POST /consolidation/run`, already `async`)

The existing `consolidate.test.ts` suite (and any other direct caller) needs `await` added at every
call site — mechanical, but real: flag explicitly as slice-1 migration cost, not a footgun to
discover later. When `mode === 'off'` (default) no `await` in the new branch is ever reached before
the function's only other awaits (none today), so behavior for existing callers who don't await
correctly would only break if they rely on synchronous return — grep for direct (non-awaited) calls
before merging.

### 1.5 Per-run cap and validation

`maxPerRun` (default **200**, same order of magnitude as the existing `maxGroupSize` default 500)
bounds total judge calls across the *entire* `runConsolidation` call, not per group — mirrors
`groupsSkipped` observability: add `summary.contradictionCapReached: boolean` so a report can tell
the difference between "no contradictions found" and "ran out of budget before finishing."

`minSimilarity`/`minConfidence` are validated the same way `resolveAutoAcceptThreshold` already
validates `autoAcceptThreshold`: an out-of-range value (`minSimilarity` not in `[0, mergeThreshold)`,
`minConfidence` not in `[0, 1]`) disables contradiction detection **for that run only** (logged,
non-fatal) rather than throwing — matches this config layer's established "never block a scheduled
pass on a bad value" governance pattern.

---

## 2. Proposal emission

### 2.1 Schema

`consolidation_proposals` (migration `008-consolidation.sql`) has no room for judge output today —
only `id, kind, winner_id, loser_id, similarity, status, created_at, resolved_at`. New migration
**`022-consolidation-proposal-metadata.sql`**: additive nullable column, no table rewrite needed
(unlike migration 021's CHECK-constraint rewrite — this is a plain `ALTER TABLE ADD COLUMN`, SQLite
supports this natively for a nullable column with no default-value complication):

```sql
ALTER TABLE consolidation_proposals ADD COLUMN metadata_json TEXT;
```

`kind='merge'` rows leave it `NULL` forever (unchanged shape, matches the additive-field evolution
rule ADR-001 already uses elsewhere). `kind='contradiction'` rows populate it:

```json
{
  "verdict": "contradicts",
  "confidence": 0.87,
  "winner_excerpt": "...(truncated, ~280 chars, captured at judge time)...",
  "loser_excerpt": "...(same)..."
}
```

Excerpts are captured **at judge time**, not re-derived at read time — the audit trail should
reflect what the judge actually saw, not the atom's current (possibly since-superseded-by-something-
else) text. This matches the "evidence spans mandatory" philosophy ADR-004 stage 5 already applies
to extraction.

`ConsolidationProposal` TS interface (`proposals.ts:12`) gains `metadata_json: string | null`;
a small typed helper `parseContradictionMetadata(p): ContradictionMetadata | null` lives alongside
it for callers (MCP, dashboard — §6) that want the structured shape instead of raw JSON text.

### 2.2 Winner/loser assignment

Merge-tier winner selection is usefulness-then-importance-then-recency (`consolidate.ts:331-337`) —
wrong model here. The FEAT's own framing is directional: *"when a newly-distilled atom conflicts
with an existing ... atom"* — the new atom is the presumptive correction, the old one the
presumptive stale fact. So for contradiction proposals: **`winner_id` = the newer atom
(`created_at` max), `loser_id` = the older atom.** This reuses the table's existing directional
columns unchanged (`winner_id`/`loser_id` already generically mean "would survive" / "would be
superseded" per the migration 008 comment) — no schema change needed for direction, only for
metadata.

### 2.3 Dedup

The existing unique index (`idx_consolidation_pair_pending`, `MIN(winner_id,loser_id)`/
`MAX(...)` `WHERE status='pending'`) has **no `kind` predicate** — it already covers both kinds.
The contradiction insert reuses the exact `INSERT ... SELECT ... WHERE NOT EXISTS (...)` guard
pattern the merge insert uses (`consolidate.ts:362-374`), so: at most one pending proposal per
unordered pair, regardless of kind, first-writer-wins within a single run. No new index, no new
guard logic to invent — same pattern, new caller.

### 2.4 Resolution — reuse `ProposalRepo.accept`/`reject` unchanged

**Decision: reuse `mergeAsSupersede` via the existing `ProposalRepo.accept()` path. No
contradiction-specific resolve path.**

Rationale: `mergeAsSupersede`'s semantics — "loser superseded by winner via the event log, winner's
`derived_from` gains the loser id, non-destructive, reversible via `unsupersede()`" — are exactly
what "confirm this contradiction, keep the winner" means. Same audit-trail shape, same reversibility
guarantee the FEAT text explicitly asks for ("reversible by construction"). `reject()` is likewise
identical: mark rejected, no memory mutation.

The one gap this creates: `mergeAsSupersede`'s optional `SupersedeProvenance` param
(`memory-events.ts:125`) only carries FEAT-442's auto-accept shape (`autoAccepted`, `threshold`,
`similarity`) — a human-accepted contradiction resolution produces a `supersede` event
indistinguishable from a human-accepted merge. **Accepted as-is**: the `consolidation_proposals`
row itself (kept forever, only `status` flips) is the durable record of *why* — queryable via
`GET /consolidation/proposals?status=accepted&kind=contradiction` (list already supports a `status`
filter; add `kind` as an optional second filter in slice 1, trivial `WHERE` addition) — so extending
`SupersedeProvenance`/`memory_events` payload shape is not needed for v1. Keeps the change surface
to proposals.ts + consolidate.ts; zero changes to `memory-events.ts`.

---

## 3. Judge eval fixture

Two determinism mechanisms already coexist in this codebase for different call types (explicitly
flagged in the FEAT body as a correction to the original design): ADR-005's fake embedder stubs
*embeddings*; the mock-LLM-provider pattern (`src/pipeline/mock-providers.ts`) stubs *chat/LLM
calls*. The judge is an LLM call, so it follows the second pattern.

### 3.1 Mock routing

`MockLLMProvider.chat` currently branches on `opts?.json === true || systemContent.includes('atoms')`
to detect extraction calls (`mock-providers.ts:47`). The judge also wants `json: true` for reliable
parsing — if it shared that flag with no other signal, a judge call would be misrouted into the
atom-extraction branch. New system-prompt **marker constant**, single source of truth, checked
*before* the extraction check:

```ts
// contradiction-judge.ts
export const CONTRADICTION_JUDGE_MARKER = 'astramem-contradiction-judge-v1';
```

```ts
// mock-providers.ts
const isJudge = systemContent.includes(CONTRADICTION_JUDGE_MARKER);
const isExtraction = !isJudge && (opts?.json === true || systemContent.includes('atoms'));
if (isJudge) { /* new branch, §3.2 */ }
else if (isExtraction) { /* unchanged */ }
```

### 3.2 Deterministic judge vocabulary

Mirrors the FEAT-414 `MOCK_EXTRACTION_VOCAB` pattern exactly: a new **finite, closed** table
`src/consolidate/mock-judge-pairs.ts` — not keyword heuristics (too fragile/ambiguous for a
4-way classification), but an explicit `(textA, textB) -> verdict` lookup keyed by
order-independent exact text match:

```ts
export const MOCK_JUDGE_PAIRS: Array<{
  id: string; textA: string; textB: string;
  verdict: 'agrees' | 'refines' | 'contradicts' | 'unrelated'; confidence: number;
}> = [ /* ~8-12 labeled pairs, see 3.3 */ ];
```

The mock's judge branch normalizes+sorts the two input texts, looks up the pair, and returns the
labeled verdict; an unlisted pair returns `{ verdict: 'unrelated', confidence: 0.5 }` (safe default
— never fabricates a contradiction the fixture didn't ask for).

### 3.3 Fixture + regression test

`contracts/fixtures/eval/contradiction-judge-pairs.json` — the *labeled* pair-set (same texts as
`MOCK_JUDGE_PAIRS`, single source of truth like the extraction vocab/smoke-fixture split), e.g.:

| pair | textA | textB | expected |
|---|---|---|---|
| P1 | "Port 7777 is the default." | "The default port is 7777." | agrees |
| P2 | "Default port is 7777." | "Default port is now 8888." | contradicts |
| P3 | "Uses mxbai-embed-large (1024-dim)." | "Uses mxbai-embed-large, 1024-dim, verified at boot." | refines |
| P4 | "Config lives in %APPDATA%\\Astramem." | "Ollama must be running locally." | unrelated |

New test `tests/hygiene/mock-judge-vocab-fixture-lockstep.test.ts` — same shape as
`tests/hygiene/mock-vocab-fixture-lockstep.test.ts`: asserts the fixture and `MOCK_JUDGE_PAIRS`
never drift (every fixture pair has a matching vocab entry and vice versa). New
`tests/eval/contradiction-judge-eval.test.ts` — the actual accuracy regression floor: runs every
fixture pair through `judgeContradiction()` with the mock provider, asserts 100% match (it's a
closed deterministic table, so this is a hard floor, not a statistical one — a real-provider
accuracy eval against this same labeled set is a natural v1.x follow-up once a non-mock judge is
exercised in CI, out of scope here since CI has no live Ollama).

---

## 4. The unsupersede/shipper gap

**Recommendation: accept-documented for local-only v1. Do not fix the shipper now.**

The corrected FEAT text's hard AC is: *"this gap must be fixed, or explicitly risk-accepted in
writing, before any cloud mirroring of contradiction resolution ships."* This design **ships no
cloud mirroring** — it is local-only (§0, and the slice cut in §7 drops the cloud slice entirely).
The AC's trigger condition is therefore not met yet; documenting the deferral here satisfies it for
this design.

Reasoning for why deferring is safe, not just convenient:
1. **The gap is not new or contradiction-specific.** `unsupersede` is excluded from `shipOnce`
   (`src/sync/shipper.ts:137,155,202`) for *every* supersede reversal today — a human undoing an
   accepted `'merge'` proposal already has this exact gap. FEAT-456 adds one more producer of
   `supersede` events (accepted `'contradiction'` proposals) that inherits an already-existing,
   already-documented architectural limitation; it does not create a new class of risk.
2. **The accepted resolution itself ships fine.** Accepting a contradiction proposal calls the
   unmodified `mergeAsSupersede` → a normal `'supersede'` event, which **does** ship today (only the
   *reversal* — `unsupersede` — is excluded). Multi-device state only diverges if someone later
   reverses an accepted contradiction on one device; that's a real but narrow follow-up window,
   identical in shape to the pre-existing merge-reversal gap `shipper.ts`'s own doc comment already
   calls out as "a real follow-up ... out of scope for the reversal primitive itself."
3. **No cloud consumer exists yet to be inconsistent with.** There is no server-side contradiction
   detection stage in this design (dropped from the original 3-slice cut, see §7) — so there is no
   second device/service independently believing a merge that a local `unsupersede` silently failed
   to inform. The risk only materializes once cloud-side detection ships.

**Follow-up obligation, carried forward, not closed:** whenever cloud-side contradiction detection
is actually scoped (the deferred original SLICE-3), that FEAT's own hard AC must resolve the
`unsupersede`/shipper gap — fix it (widen the sync wire schema + shipper exclusion list) or make a
fresh, then-current risk-acceptance call, per the same corrected-FEAT language. This design does not
retire that obligation; it only establishes that it isn't triggered by v1.

---

## 5. Config surface

```ts
consolidation: {
  autoAcceptThreshold: number | null;   // unchanged (FEAT-442)
  contradictionDetection: {
    /** 'off' (default) — byte-identical to pre-FEAT-456, judge never called.
     *  'dry-run' — judge runs, verdicts land in ConsolidateSummary.contradictionsPreviewed,
     *              NO row is written. Safe-rollout mode the FEAT body asks for.
     *  'enabled' — judge runs, confident 'contradicts' verdicts write kind:'contradiction' rows. */
    mode: 'off' | 'dry-run' | 'enabled';
    /** Cosine floor for judge eligibility — deliberately lower/decoupled from proposeThreshold
     *  (§1.2). Must be in [0, mergeThreshold). */
    minSimilarity: number;
    /** Judge confidence floor to act on a 'contradicts' verdict. Must be in [0, 1]. */
    minConfidence: number;
    /** Cap on judge calls per runConsolidation() call (cost/latency guard, §1.5). */
    maxPerRun: number;
  };
};
```

Defaults (`defaultConfig()`, `config.ts:298`):
```ts
consolidation: {
  autoAcceptThreshold: null,
  contradictionDetection: { mode: 'off', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200 },
},
```

`mode` as a three-state enum (rather than a separate `enabled: boolean` + `dryRun: boolean`) mirrors
the existing `distill.durabilityGate: 'strict' | 'lenient' | 'off'` precedent in this same file
(`config.ts:233`) and avoids the ambiguous `enabled:false, dryRun:true` combination two independent
booleans would allow. This is one field beyond the FEAT body's literal `{ enabled, minConfidence,
maxPerRun }` listing — `minSimilarity` is a necessary addition given §1.2's banding, and `enabled`
is folded into `mode`.

---

## 6. MCP / dashboard / digest surfacing (slice 2 payload)

- **`list_consolidation_proposals`** (`mcp/server.ts:754`): already `kind`-agnostic — no new tool
  needed. Slice 2 work: (a) enrich the response with parsed `metadata_json` fields when
  `kind==='contradiction'` (verdict/confidence/excerpts) so an agent can see *why* without a second
  round-trip; (b) update the tool description to mention contradiction proposals, not just
  near-duplicates; (c) add an optional `kind` filter to `ProposalRepo.list()` / the REST route (used
  by §2.4's audit query too).
- **`resolve_consolidation_proposal`** (`mcp/server.ts:778`): no code change — confirmed identical
  behavior for both kinds (§2.4). Description text update only.
- **Dashboard** (`/dashboard/consolidation`): add a `kind` badge/column so pending contradiction and
  merge proposals are visually distinct in the existing table.
- **Session digest** (`buildSessionDigest`, `server/queries/provenance.ts:107`, shared by
  `GET /sessions/:id/digest` and the MCP `session_digest` tool): add `pending_contradictions: number`
  — count of pending `kind='contradiction'` proposals whose `winner_id` or `loser_id` is one of this
  session's memory ids. **Documented latency, not a bug:** consolidation is an offline/periodic pass
  (ADR-004 stage 9, "not per-ingest") — a digest read immediately after this session's own distill
  will show `0` for atoms just created, the same way merge-tier proposals are invisible to a digest
  until a consolidation run has actually happened since. The count only ever reflects a *prior* run.

---

## 7. Slice cut

Two slices (down from the original three — no cloud slice; see §4 for why that's deferred, not
dropped-silently).

### SLICE-1 — Detection + proposals + tests (5 pts)

Files: `migrations/022-consolidation-proposal-metadata.sql`, `src/config/config.ts`,
`src/consolidate/contradiction-judge.ts` (new), `src/consolidate/mock-judge-pairs.ts` (new),
`src/consolidate/consolidate.ts`, `src/consolidate/proposals.ts`, `src/pipeline/mock-providers.ts`,
`src/pipeline/handlers/consolidate.ts`, `src/server/routes/consolidation.ts` (await only),
`contracts/fixtures/eval/contradiction-judge-pairs.json`, plus tests.

Acceptance criteria:
- **AC-1** GIVEN `contradictionDetection.mode` is `'off'` (default) WHEN `runConsolidation` runs
  THEN no judge call is made and `ConsolidateSummary` is byte-identical to pre-FEAT-456 output.
- **AC-2** GIVEN `mode='dry-run'` and a judge-eligible pair the mock judge labels `contradicts` at
  `confidence >= minConfidence` WHEN `runConsolidation` runs THEN the pair appears in
  `summary.contradictionsPreviewed` and no `consolidation_proposals` row is written.
- **AC-3** GIVEN `mode='enabled'` and the same pair WHEN `runConsolidation` runs THEN exactly one
  row is inserted with `kind='contradiction'`, `winner_id`=newer atom, `loser_id`=older atom,
  `status='pending'`, `metadata_json` populated with verdict/confidence/excerpts.
- **AC-4** GIVEN a pending `'merge'` proposal already exists for pair (X,Y) WHEN the judge also
  evaluates (X,Y) as `contradicts` THEN no second pending row is created for that pair (existing
  unique-pending-pair index holds across kinds).
- **AC-5** GIVEN verdict `contradicts` but `confidence < minConfidence` WHEN `runConsolidation` runs
  THEN no proposal of either kind is created for that pair.
- **AC-6** GIVEN a propose-tier pair (`proposeThreshold <= sim < mergeThreshold`) the judge labels
  `agrees` or `refines` WHEN `runConsolidation` runs THEN the existing `kind='merge'` proposal path
  fires unchanged; GIVEN verdict `unrelated` THEN neither kind is created.
- **AC-7** GIVEN more judge-eligible pairs than `maxPerRun` WHEN `runConsolidation` runs THEN at
  most `maxPerRun` judge calls are made, the run completes without error, and
  `summary.contradictionCapReached` is `true`.
- **AC-8** GIVEN `contracts/fixtures/eval/contradiction-judge-pairs.json` WHEN every fixture pair is
  run through the mock judge THEN every pair returns its expected verdict, and the lockstep test
  fails loudly on vocab/fixture drift.
- **AC-9** GIVEN existing `runConsolidation` callers WHEN this slice ships THEN all are updated to
  `await` it and the existing `consolidate.test.ts` suite passes unchanged for `mode='off'`.

### SLICE-2 — MCP / dashboard / digest surfacing (2 pts)

Files: `src/mcp/server.ts`, `src/consolidate/proposals.ts` (`kind` filter), `src/server/routes/consolidation.ts`,
dashboard consolidation route/template, `src/server/queries/provenance.ts`.

Acceptance criteria:
- **AC-10** GIVEN a pending `kind='contradiction'` proposal WHEN `list_consolidation_proposals` is
  called THEN the response includes parsed `metadata_json` fields alongside `winner_text`/`loser_text`.
- **AC-11** GIVEN the same proposal WHEN `resolve_consolidation_proposal` accept/reject is called
  THEN behavior is identical to a `'merge'` proposal (no code branch by kind).
- **AC-12** GIVEN `/dashboard/consolidation` renders pending proposals WHEN both kinds are present
  THEN a `kind` badge distinguishes them.
- **AC-13** GIVEN a session's memories include the `winner_id` or `loser_id` of a pending
  contradiction proposal WHEN its digest is read (REST or MCP) THEN `pending_contradictions` reflects
  that count; GIVEN no consolidation run has happened yet since those atoms were created THEN the
  count is `0` (documented latency, §6).

**Total: 7 pts**, down from the original 10 pts (2+5+3) — the 3-pt cloud slice is deferred (§4), not
replaced by anything in this cut.

---

## 8. Non-goals (v1, explicit)

- **No auto-action.** Every `contradicts` verdict, however confident, produces a `pending` proposal
  only — never an auto-supersede. FEAT-442's `autoAcceptThreshold` auto-accept tier was justified by
  a **deterministic** cosine-similarity signal; that justification does not transfer to a
  **probabilistic** LLM judge without its own case being made (explicitly called out in the corrected
  FEAT body) — no such case is made or assumed here.
- **No cloud-side detection or mirroring** in this design (§4) — local-only.
- **No new MCP tool** — `list_consolidation_proposals`/`resolve_consolidation_proposal` are reused
  unchanged in shape (enriched payload only).
- **No `memory_events`/`SupersedeProvenance` schema change** (§2.4) — proposal `kind` is the audit
  record, not a new event-payload field.
- **No batched judge calls** — one pair per LLM call in v1 (§1.3).

## 9. Open questions / risks carried into slice review

- `minSimilarity=0.6` / `minConfidence=0.7` / `maxPerRun=200` are reasoned defaults, not
  eval-derived — same "opt-in only until eval'd, do not change this default casually" caveat
  `distill.durabilityGate` already carries. Real-corpus tuning is v1.x work once `mode='dry-run'`
  has run against production data.
- Judge latency: at `maxPerRun=200` sequential single-pair calls, a consolidation pass with
  `contradictionDetection.mode != 'off'` could add meaningful wall-clock time to what is today a
  synchronous, sub-second, no-LLM pass. Worth a follow-up perf note once slice 1 lands (batching or
  bounded concurrency is a natural v1.x lever, not a v1 blocker given the pass is periodic/offline).
- `kind` filter added to `ProposalRepo.list()`/REST in slice 2 is a small surface growth beyond
  "surfacing only" — flagged here so review doesn't read it as scope creep; it's needed for §2.4's
  audit query and is trivial (one more optional `WHERE`).
