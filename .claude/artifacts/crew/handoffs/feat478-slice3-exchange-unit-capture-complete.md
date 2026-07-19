# Handoff — FEAT-478 Slice 3: proxy exchange-is-the-unit-of-capture

- **Objective**: Fix `src/capture/proxy.ts`'s relevance gate applying per-turn instead of
  per-exchange, which could spool an orphaned user question with no assistant answer.
- **Owner**: fullstack-dev
- **Branch**: `feat/478-proxy-exchange-unit`
- **PR**: https://github.com/astragenie/astramem-local/pull/442
- **Decision**: Operator-mandated Option A — the exchange is the unit of capture. No
  minChars/per-role tuning this slice (explicitly deferred).

## What changed

`createProxyCaptureTee`'s `finishCapture` (src/capture/proxy.ts) now gates in two phases:

1. Gate each turn against the persistent `recentHashes` dedup window (unchanged call to
   `gateRelevance`) AND a new **exchange-local** hash set (`exchangeSeenHashes`) that
   preserves intra-exchange dedup without mutating `recentHashes` yet.
2. Require a surviving `role: 'assistant'` turn in `gated` before spooling anything — if
   none survives (gated out as too_short/structural_junk, OR never parsed into a turn at
   all because the response body was corrupt/unrecognized), the whole exchange is
   discarded via early `return`.
3. Only after that decision, record survivors' hashes into `recentHashes` via
   `recordCapturedTurnHash` — this is the AC-4 fix: recording during phase 1 (the old
   code's behavior) would poison the dedup window with turns from exchanges later
   discarded, and a LATER identical question that DID get a good answer could be
   silently deduped away.

## Tests

- `tests/capture/proxy-decompress.test.ts` — updated the corrupt/truncated-gzip test:
  was "user turn still captures, no assistant turn" (Option B); now asserts nothing
  spools, with a comment citing FEAT-478 Option A and the orphaned-question rationale.
- `tests/proxy/usage-storage-e2e.test.ts` — updated the unrecognized-response-shape
  test: was asserting a DB row with `proxy_usage_json: NULL`; now asserts
  `drainIngestSpool` drains 0 and no row exists at all, same reasoning comment.
- `tests/capture/proxy.test.ts` — 3 new tests added right before the existing
  "fails silent on a malformed body" test:
  - AC-1: too-short assistant reply gates the WHOLE exchange, not just the reply.
  - AC-3 (regression guard): terse-but-VALID reply is NOT suppressed — both turns spool.
  - AC-4: a discarded exchange's turns do not poison `recentHashes` — a later identical
    question with a good answer still spools.
- Existing test "dedup window persists ACROSS requests" (tests/capture/proxy.test.ts)
  traced through by hand against the new logic — still passes unmodified, because the
  duplicate user turn in the second exchange is caught by the (already-populated)
  `recentHashes` from the first (successfully spooled) exchange, and the surviving
  assistant turn alone still satisfies the new "assistant survived" requirement.

## Evidence

- `bunx vitest run tests/capture tests/proxy` → 15 files, 148 tests, all passing.
- `bunx tsc --noEmit -p .` → clean.
- `bunx tsc --noEmit -p tsconfig.eval.json` → clean (this path isn't imported by the
  eval harness; confirmed rather than assumed).

## Scope discipline

Touched only `src/capture/proxy.ts` + the 4 test files above. Did not touch minChars,
did not add a per-role gate (both explicitly deferred per dispatch), did not touch wire
format, distill, or unrelated capture paths.

## Confidence / risks

High confidence — logic traced by hand against every existing test in the
`createProxyCaptureTee` describe block before running, then confirmed green. No open
risks; no follow-up FEAT needed for this slice.

## Suggested next handoff

Slice 3 of the 0.20 release — hand back to the loop/dispatcher for review + validation
gates, then continue the 0.20 backlog.
