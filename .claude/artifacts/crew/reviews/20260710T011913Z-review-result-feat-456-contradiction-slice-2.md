# Review result — FEAT-456 SLICE-2 (contradiction surfacing)

- **Branch**: `feat/feat-456-s2-surfacing`
- **Commit**: c4aa5a3
- **Worktree**: `C:\work\mega\astramemory-local-worktrees\feat-456-s2`
- **Spec**: `docs/specs/FEAT-456-contradiction-design.md` §6/§7, AC-10..AC-13
- **Diff**: `git diff origin/main...HEAD`

## review_decision: PASS

## Scope check

Diff touches exactly the files the design's §7 SLICE-2 file list names, plus their tests:
`src/consolidate/proposals.ts`, `src/mcp/server.ts`, `src/server/queries/provenance.ts`,
`src/server/routes/consolidation.ts`, `src/server/routes/dashboard-consolidation-html.ts`.

- No changes to the detection stage (`contradiction-judge.ts`, `consolidate.ts` judge-call path
  untouched — diff doesn't even list those files).
- No auto-action introduced anywhere in the diff.
- No new MCP tool registered — only `list_consolidation_proposals`, `resolve_consolidation_proposal`,
  and `session_digest` had description/behavior updates on existing tools.
- `ProposalRepo.accept()` / `.reject()` (proposals.ts:105-124) are **unmodified** in this diff — the
  resolve path is identical for `kind='merge'` and `kind='contradiction'` rows, confirming AC-11.
  `resolve_consolidation_proposal`'s handler (`mcp/server.ts`) has no kind-conditional branch either.

## Findings by AC

**AC-10 (list enrichment)** — PASS. `list_consolidation_proposals` now spreads
`contradiction_metadata: parseContradictionMetadata(p)` onto each row (`mcp/server.ts:865-871`) in
addition to the existing `winner_text`/`loser_text`. Covered by
`tests/mcp/server.test.ts:1079` ("enriches a contradiction proposal with parsed metadata").

**AC-11 (identical resolve path)** — PASS, verified two ways: (a) static — `ProposalRepo.accept/reject`
carry no kind branch; (b) dynamic — the same test asserts `resolve_consolidation_proposal` on a
`kind='contradiction'` row drives `superseded_by` exactly like a merge accept.

**AC-12 (dashboard kind badge)** — PASS. `renderKindBadge()` (`dashboard-consolidation-html.ts:146-148`)
replaces the old plain-text `kind` cell; CSS classes `kind-merge`/`kind-contradiction` added.
`kind` is HTML-escaped via `esc()` before being interpolated into the class attribute — safe even
though the DB `CHECK` constraint already restricts values to the two enum members,
belt-and-suspenders. Covered by `tests/server/dashboard-consolidation-html.test.ts:144`.

**AC-13 (pending_contradictions digest field)** — PASS. New `SessionDigest.pending_contradictions`
computed via an `EXISTS`-correlated subquery in `buildSessionDigest`
(`src/server/queries/provenance.ts:159-171`):
```sql
SELECT COUNT(*) FROM consolidation_proposals cp
WHERE cp.kind='contradiction' AND cp.status='pending'
  AND (EXISTS(...m.id=cp.winner_id AND m.session_id=?) OR EXISTS(...m.id=cp.loser_id AND m.session_id=?))
```
Logic verified correct: filters `kind`+`status` up front, checks both `winner_id` and `loser_id`
sides via `memories.id` (PK) lookups joined on `session_id`. Test coverage exercises both the
winner-side and loser-side membership (`tests/server/digest.test.ts:104`) and the documented-latency
zero case (`tests/server/digest.test.ts:127`). Both REST (`GET /sessions/:id/digest`) and MCP
(`session_digest`) go through the same `buildSessionDigest` — parity is asserted by a **real** new
test (`tests/mcp/why-digest-conformance.test.ts` "digest: pending_contradictions is identical on REST
and MCP") that seeds a pending contradiction row, hits both surfaces, and does a structural
`toEqual` — not a rubber-stamped duplicate of the existing why/digest parity tests.

Query-plan note (LOW, non-blocking): `consolidation_proposals` has no index covering `(status, kind)`
or `(winner_id)`/`(loser_id)` individually — only the partial unique index on the unordered pair
(`idx_consolidation_pair_pending`, `WHERE status='pending'`), which doesn't help this predicate. The
new subquery's outer scan is therefore a full table scan of `consolidation_proposals` per
`session_digest` call, with two PK-indexed `EXISTS` lookups against `memories` per row. This matches
the design doc's explicit assumption (§6, "the table is small" — same reasoning `proposals.ts`'s
`list()` docblock gives) since it's a human/agent-resolved propose-only queue, not a bulk table. Not
a blocker; worth a covering index if consolidation proposal volume ever grows materially.

## `kind` filter — injection / validation

`ProposalRepo.list()` (`src/consolidate/proposals.ts:79-89`) builds `WHERE` clauses with `?`
placeholders and passes `params` positionally to `.all(...params)` — fully parameterized, no string
interpolation of the filter values. No injection surface.

Junk `kind` value handling, verified by code inspection (not exercised by a dedicated test — see
below):
- **REST** (`src/server/routes/consolidation.ts:59-65`): `ListQuerySchema.safeParse(req.query)` — a
  non-enum `kind` fails `.safeParse`, handler returns `400 {error:'invalid', details:...}` before
  `proposals.list()` is ever called. Correct — not a silent full list.
- **MCP**: `list_consolidation_proposals`'s `inputSchema` uses the same `z.enum(['merge',
  'contradiction']).optional()`. Confirmed in the SDK
  (`node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js:177-182`) that `registerTool`
  runs `safeParseAsync` against `inputSchema` before invoking the handler and throws
  `McpError(InvalidParams, ...)` on failure — same non-silent-failure guarantee as REST.

**LOW / test gap**: neither surface has a test asserting the junk-`kind` → 400/InvalidParams behavior
specifically (existing tests only cover the happy-path `kind=merge`/`kind=contradiction` filter). The
mechanism is correct and consistent with how the pre-existing `status` enum is already handled
elsewhere in this codebase, so not blocking, but worth a follow-up test.

## Defensive metadata parsing

`parseContradictionMetadata` (`src/consolidate/proposals.ts:46-52`) returns `null` for `null`
`metadata_json` and wraps `JSON.parse` in try/catch, returning `null` on parse failure rather than
throwing — confirmed by reading the implementation. **LOW / test gap**: no test seeds a row with
malformed `metadata_json` (e.g. `'not valid json'`) to exercise the catch branch directly; the two
existing contradiction-metadata tests only use well-formed JSON. Code is correct as written; a test
would just lock in the "never throws" contract explicitly.

## REST/MCP parity

Both `GET /sessions/:id/digest` (`src/server/routes/digest.ts`) and MCP `session_digest`
(`src/mcp/server.ts:542`) call the same `buildSessionDigest(db, sessionId)` — single source of
truth, no duplicated logic to drift. Confirmed via `tests/mcp/why-digest-conformance.test.ts`, which
is a genuine byte-identical-JSON assertion across both transports (see AC-13 section above).

## Build / test

```
bun run build   -> tsc -p .  (clean, 0 errors)
bun run test    -> Test Files 183 passed (183)
                    Tests      2121 passed | 6 skipped (2127)
```
Matches the expected 183 files / 2121 passed / 0 failed exactly (6 skipped is pre-existing/unrelated
to this diff).

## Summary

Clean, tightly-scoped surfacing slice. No detection-stage or auto-action creep, resolve path is
provably byte-identical across proposal kinds, `kind` filter is parameterized and additive on all
three surfaces, digest math is correct and covered on both winner/loser sides plus the
documented-latency zero case, and REST/MCP parity is asserted by a real (not rubber-stamped) test.
Build and full test suite both green at the exact expected counts.

Two LOW-severity, non-blocking follow-ups (test-coverage gaps only, not correctness issues):
1. No test for junk `kind=` value on REST (`400`) / MCP (`InvalidParams`) — behavior verified
   correct by code inspection.
2. No test for malformed `metadata_json` hitting `parseContradictionMetadata`'s catch branch —
   behavior verified correct by code inspection.

Neither blocks merge.
