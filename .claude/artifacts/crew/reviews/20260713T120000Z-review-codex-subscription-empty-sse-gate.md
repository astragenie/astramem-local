# Review: empty-SSE poison gate — codex-subscription LLM provider

**Reviewer**: crew:reviewer (independent)
**Scope**: `src/providers/llm/codex-subscription.ts` — empty/whitespace-text poison gate in `chat()` (introduced inside commit `863195d`, message describes an unrelated model-catalog fix) + its 4 covering tests (commit `3cc3a79`). Also a quick sanity pass on the model-catalog change riding in the same commit.
**Verdict**: **NEEDS_FIX** → **PASS on re-verify** (see addendum below)

## Commits under review
- `863195d` — "fix(codex): read the account's real model catalog instead of failing with an opaque 400" — contains BOTH the catalog-validation feature (its stated purpose) AND the empty-text poison gate (unstated, swept in from a shared working tree).
- `3cc3a79` — "test(codex): empty-SSE poison gate coverage" — adds 4 tests for the gate and documents that it was authored in a different session than the commit that carries it.

## Tests
```
bunx vitest run tests/providers/codex-subscription-llm.test.ts
```
27 passed | 1 skipped (28) — all green, no network calls (mocked `globalThis.fetch`).
```
bunx vitest run tests/providers/codex-model-drift.test.ts
```
6 passed — all green (catalog-change tests, sanity-checked per ask #5).

## Findings

**[HIGH] `src/providers/llm/codex-subscription.ts:557-574` (gate) contradicts an existing, deliberate empty-text fallback at `src/distill/pipeline.ts:108`, and will poison real distill jobs on legitimate output.**

The gate's own comment claims "an empty (or whitespace-only) text is never a legitimate success for any call site of this provider" and throws `TransientError` unconditionally on empty `text`. That premise is false for the compaction call site:

- `src/distill/stages/04-compact.ts:54-90` (`compactChunk`) calls `provider.chat()` with no special-casing of an empty result — it returns `{ text: result.text.trim(), ... }` as a normal, non-error result.
- `src/distill/pipeline.ts:108` then does `compactedChunks = compactResults.map(r => ({ index: r.index, text: r.text || chunks[r.index]?.text || '' }))` — this line exists specifically because a compacted chunk *can legitimately come back empty* (e.g. a short tail chunk that's pure filler — "Thanks, that worked!" — which the compact system prompt at `04-compact.ts:17-42` explicitly instructs the model to strip entirely: "Remove ... Generic acknowledgment phrases"). The pipeline's designed response to that is to silently fall back to the chunk's original text, not to treat it as a failure.

With the new gate in place, that fallback path is unreachable whenever `codex-subscription` is the configured compaction provider (`config.llm.compaction.provider`, wired in `src/providers/index.ts:124-127` — this is a live, independently-selectable path, not hypothetical). A legitimately-empty compaction now throws `TransientError` instead. Per `src/distill/stages/04-compact.ts:96-107`, `compact()` is an unguarded sequential loop over all chunks with no per-chunk try/catch, so the throw aborts the *entire* compact stage, not just the one chunk. Per `src/pipeline/worker.ts:82` / `:205-206`, a `TransientError` retries up to `MAX_ATTEMPTS` and then `repo.markPoison(job.id)` — the whole distill job for that transcript is poisoned. Every retry re-runs the same chunks against the same input, so if the "nothing worth keeping" verdict is stable (likely, for genuinely content-free filler), every attempt fails identically and the job poisons deterministically — this repo has already lost real sessions to this exact failure class (see `distill-broken-is-ingest-starvation` memory).

Net effect: a provider-level gate meant to catch **SSE shape drift** (a real failure mode) also catches **correct, expected model behavior** at one specific call site, and the consequence for that call site is job death rather than a graceful fallback that already existed and worked.

Suggested fix — one of:
1. Don't gate at the shared `chat()` level for this failure shape. Move the empty-text check to the call sites that can't already tolerate it (i.e., leave `04-compact.ts` un-gated, matching its own established contract at `pipeline.ts:108`), and keep it for the JSON-mode extraction path where an empty string is never a valid JSON blob anyway (see below — that path is currently redundant, not broken).
2. If the gate must stay shared, thread a signal (e.g., `opts.json === true` isn't enough since compaction also isn't json-mode but *is* JSON-agnostic; consider an explicit `opts.allowEmpty` or similar) so compaction opts out and keeps its existing fallback semantics.
3. At minimum, distinguish "drift" from "legitimate empty" using something more specific than trim-length-zero — e.g., only throw when the SSE body actually failed to yield a `message` output item AND the input was substantial, vs. genuinely empty model output.

## Gate-by-gate

**1. Correctness — call sites:**
- `src/entity/extract-entities.ts:70-82` — wraps `provider.chat()` in a bare `try { } catch { return []; }`. An empty-text throw is swallowed and treated as "no entities," which is exactly what would have happened anyway (empty string fails `tryParseEntities`). **No behavior change, no issue.**
- `src/distill/stages/05-extract.ts:87-100` (`extractChunk`, via `callExtract`) — no try/catch around the call; `tryParseAtoms(result.text)` on an empty string already fails to parse and the function already throws its own `TransientError` ("Zod/JSON parse failed"). The new gate throws slightly earlier with a different message but the same error kind and the same retry/poison treatment. **No material behavior change.**
- `src/distill/stages/04-compact.ts` / `src/distill/pipeline.ts:108` — see [HIGH] above. **Real regression.**
- `src/doctor/probes/llm-chat-probe.ts:12-49` — wraps the whole probe call in try/catch and already had its own empty-response check (`if (!result.text || result.text.trim().length === 0)` → `ok: false`). A thrown `TransientError` lands in the probe's `catch`, producing an equivalent `ok: false` with a more specific message. It's a single one-shot probe call with no retry loop of its own, so **no false-positive retry-loop risk** — confirmed, this part of gate 1 is fine.

**2. TransientError vs DeterministicError:** Sound, and consistent with this codebase's existing convention. `src/pipeline/errors.ts:4-9` explicitly documents that LLM output is stochastic and a single bad sample should retry before poisoning — the exact same rationale `05-extract.ts` already uses for JSON-parse failures. If OpenAI permanently changes the SSE shape, every retry fails identically and the job poisons after `MAX_ATTEMPTS` — that's an acceptable terminal state for a genuine, permanent upstream break (the alternative, `DeterministicError`, would poison on the very first hit with no chance to distinguish transient flakiness from real drift). No change requested here — this part of gate 2 passes independent of the [HIGH] finding above, which is about *when* the check should fire, not which error type it throws.

**3. Tests (commit `3cc3a79`):** 4 new tests, all meaningful:
- empty text + json-mode → throws with the "for a json-mode request" message
- whitespace-only text → throws
- empty text + plain-chat → throws with the "for a plain-chat request" message
- non-empty text → passes through unchanged, usage intact

Mock shape (`codexSseResponse(...)` helper, not shown in the diff but exercised by the passing suite) round-trips through the real `parseSseResponse` event format (`response.output_item.done` / `response.completed`), not a synthetic shortcut — confirmed by reading `parseSseResponse` at `codex-subscription.ts:188-229` against the test helper's usage. No network calls (`globalThis.fetch` mocked). No gap: the tests correctly document the gate's intended behavior; the problem is the gate's placement/scope, not the tests.

**4. Production-readiness lens (D2 extraction default):** The [HIGH] finding is precisely a production-readiness concern — this is the kind of thing that only surfaces under real traffic (a genuinely low-content chunk), not under any test in this suite (all 4 new tests are extraction/plain-chat shaped; none exercise the compaction call site's fallback contract). Before this provider becomes a default, either fix the gate's scope or add an explicit test asserting `04-compact.ts` + `pipeline.ts:108`'s fallback still works end-to-end through `codex-subscription` with an empty result.

**5. Model-catalog change (`863195d`, quick pass only):** `readCodexModelCatalog` / `pickCheapestCodexModel` / `validateCodexModel` — read-only, wrapped in try/catch, returns `null` on any failure (missing file, malformed JSON, non-array `models`), and is only ever used to `.warn()`, never to throw or block construction. Correctly non-fatal per its own doc comment and the "no catalog → no validation → do not block" test at `codex-model-drift.test.ts:86-93`. Runs once at construction (`readFileSync`, not on the hot path). No correctness issues found in the quick pass.

## Summary
- Gate mechanism, error-kind choice, and test coverage for what's tested: sound.
- Gate's blanket scope ("never a legitimate success for any call site") is factually wrong for the compaction call site and will poison real jobs on correct model output. This needs a fix before the gate ships as-is, and doubly before this provider becomes a default.
- Model-catalog change: clean, no issues.

---

## Addendum: re-verify of narrowed gate (2026-07-13, same day, working-tree diff)

Builder applied the recommended fix (option 1 from above). Re-verified `git diff` on both files.

**Gate condition** (`src/providers/llm/codex-subscription.ts:568`, was `text.trim().length === 0`, now `opts?.json === true && text.trim().length === 0`): correct narrowing. Only JSON-mode call sites (05-extract.ts) hit the throw now; plain-chat requests (04-compact.ts) fall through to the normal return path with `text` possibly `''`, preserving `pipeline.ts:108`'s `r.text || chunks[r.index]?.text || ''` fallback exactly as it worked before the gate existed. The now-unconditional `reqKind` branching was removed along with the dead variable — no leftover `reqKind` reference in the file (checked).

**Comment**: rewritten to state both halves explicitly — why JSON-mode empty is still a poison signal, and why plain-chat empty is deliberately NOT one, citing `04-compact.ts`'s filler-strip system prompt and `pipeline.ts:108` by name, plus the blast-radius reasoning (`compact()` has no per-chunk try/catch → stage-wide retry → job poison) that motivated treating this as more than a style nit. This is the right level of documentation for a gate whose non-obvious half (the exclusion) is exactly what a future editor would be tempted to "fix" back to a uniform check.

**Tests**: the third test (previously "throws TransientError on empty text for a plain-chat request") was correctly flipped to assert the opposite — `res.text === ''` and usage still recorded (`{in: 8, out: 0, usd: 0}`) — documenting the 04-compact case by name in its title and a new comment block. The other three tests (json-mode empty, whitespace-only json-mode, non-empty pass-through) are unchanged and still correct. Ran `bunx vitest run tests/providers/codex-subscription-llm.test.ts`: **27 passed | 1 skipped (28)**, no failures.

**Scope check**: diff touches only the gate's `if` condition, its comment, the thrown message (dropped the now-constant `reqKind` interpolation), and the 3 test edits described above. No scope creep into the model-catalog code or any other function.

**Verdict: PASS.** The compact-path concern from the original NEEDS_FIX is closed. Safe to commit.
