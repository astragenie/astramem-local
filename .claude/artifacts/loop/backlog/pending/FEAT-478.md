---
id: FEAT-478
status: done
priority: null
category: bug
target_release: "0.20"
created: 2026-07-13
updated: 2026-07-19
resolution: "2026-07-19 (PR #442, merged 90ee574): Option A — exchange is the unit of capture. proxy.ts now discards the whole exchange unless a role:'assistant' turn survives the relevance gate (kills the orphaned-question / 'gzip.'-reply-gated-out bug), and records dedup hashes only for spooled exchanges (AC-4, no dedup-window poisoning). 2 Option-B tests rewritten deliberately; 3 new tests. Both reviewers approved. LOW follow-ups deferred to 0.21: (1) tool_use-only-response test locking the now-load-bearing no-assistant-turn->discard invariant, (2) optional live-proxy smoke."
depends_on: [FEAT-458]
slices: []
derived_from: live proxy capture test, 2026-07-13
cross_product: [astramem-local]
autonomous_safe: null
triage_notes: "Found by pointing a REAL Claude Code session at the proxy (not by fixtures). NOT yet fixed — the fix is a product judgment call that conflicts with two deliberate existing tests, so it needs an operator decision before implementation. Evidence below is from live traffic."
---
## Description

**Proxy capture can spool a question with no answer.**

The relevance gate is applied **per turn**, but the proxy captures a
**conversational exchange**. `src/capture/proxy.ts` (~line 780):

```ts
const gated: ProxyTurn[] = [];
for (const turn of turns) {
  if (gateRelevance(turn, recentHashes, opts.relevanceGate)) continue;  // drop
  recordCapturedTurnHash(recentHashes, turn.text, opts.relevanceGate.dedupWindow);
  gated.push(turn);
}
if (gated.length === 0) return;   // only bails if EVERY turn was dropped
```

So if the assistant reply is dropped but the user turn survives, an envelope is
spooled containing **the question and no answer**.

## Observed live (this is not theoretical)

Real Claude Code session through the proxy, capture ON, 2026-07-13:

| Envelope | turns | content |
|---|---|---|
| 1 | 2 | user + assistant ✅ |
| 2 | **1** | **user only — assistant reply missing** ❌ |

Envelope 2's prompt was *"In one word: what compression does Anthropic use on
responses?"* and the reply was **`"gzip."` — 5 characters.** Default
`relevanceGate.minChars` is **8**. The reply was gated out as `too_short`; the
(very long) user prompt was not. Result: an orphaned question.

Note the reply was NOT a parse failure — `extractUsageMetadata` on the same
response body succeeded (`output_tokens: 66`), so the response decompressed and
parsed fine. The gate dropped it.

## Why this matters

A question with no answer is not a partial memory — it is negative value. It is
literally the "memory store full of unanswered questions" failure mode that
FEAT-458's whole S5/S7 arc was spent eliminating (wrong wire format, then gzip,
each of which dropped assistant replies). Those were fixed; this one produces the
same bad output by a different route, and by design rather than by bug.

Terse answers ("gzip.", "yes", "7777", "no — see line 40") are exactly the kind of
high-signal replies an agent gives, and they are the ones this gate discards.

## The design question (needs an operator decision — DO NOT just implement)

**What is the unit of capture: the turn, or the exchange?**

Option A — **exchange is the unit** (my recommendation). Require a surviving
assistant turn; otherwise spool nothing. Rationale: an orphaned question has no
value, and a terse-but-correct answer plus its question has high value.

Option B — **turn is the unit** (status quo). Keep whatever survives the gate.

**This is genuinely contested, not obvious.** Two deliberate existing tests assert
Option B and would have to be changed:
- `tests/capture/proxy-decompress.test.ts` — *"a corrupt/truncated gzip response
  fails silently: **the user turn still captures**, no throw, no assistant turn
  fabricated"*
- `tests/proxy/usage-storage-e2e.test.ts` — an unrecognized response shape still
  spools an envelope, with `proxy_usage_json` NULL

Both were written intentionally. Whoever fixes this must decide whether those
tests encode the right intent, and change them knowingly if not.

## Sub-issue found while investigating (smaller, less contested)

`recordCapturedTurnHash` is called **during** gating, i.e. for turns in exchanges
that are then discarded by the `gated.length === 0` bail. That poisons the dedup
window with turns from exchanges we never stored — so a later *identical question
that DID get a good answer* could have its question silently deduped away, landing
an answer without its question. Recording hashes only for exchanges actually
spooled is strictly safer, and is orthogonal to the A-vs-B decision above.

## Acceptance criteria (assuming Option A is chosen)

- AC-1 — Given a request whose assistant reply is gated out as `too_short`, when
  the exchange completes, then NOTHING is spooled (no orphaned question).
- AC-2 — Given a request whose assistant reply never parsed (corrupt body,
  unrecognized shape), when the exchange completes, then NOTHING is spooled.
- AC-3 — Given a complete exchange with a terse-but-valid reply, when it
  completes, then it IS spooled with both turns. (The fix must not suppress good
  data — regression guard.)
- AC-4 — Given an exchange that was discarded, when an identical question is later
  asked AND answered properly, then that question is NOT deduped away — its hash
  must never have been recorded.
- AC-5 — The two existing tests asserting Option B are updated deliberately, with
  the reasoning recorded, not silently deleted.

## Also worth considering

`minChars: 8` may simply be wrong for assistant turns in a proxy context. A
per-role gate (lenient for assistant replies, strict for user prompts) might be
better than a single threshold — but that is a tuning question, secondary to the
unit-of-capture question above.
