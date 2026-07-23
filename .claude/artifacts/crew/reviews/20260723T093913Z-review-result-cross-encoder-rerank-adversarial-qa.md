# Adversarial QA — cross-encoder rerank path (2026-07-23)

Scope: `src/search/rerank.ts`, `src/search/onnx-cross-encoder.ts`,
`src/search/onnx-rerank-registry.ts`, evidence-excerpt precedence
(`src/search/search.ts` + `src/contracts/wire-hit.ts`), plus the six
landmines named in the dispatch. Read-only investigation — no source edited.
All findings below marked **reproduced** were exercised live via a throwaway
vitest file (`tests/search/_qa_repro_rerank.test.ts`, deleted after use, no
diff left in the tree); findings marked **static** are code-trace only.

Format: `path.ts::symbol | severity | break-case → observed vs expected | repro`

---

## 🔴 HANG (fake backend) → 🟠 downgraded to LOUD CRASH (real backend, see correction below) — `onnx-cross-encoder.ts::OnnxCrossEncoderProvider.score` — fractional `batchSize` in (0,1)

**Read the "⚠️ CORRECTION" subsection immediately below before treating this
as a hang** — the initial repro used a permissive fake DI backend; a
follow-up check against the real `@huggingface/transformers`/
`onnxruntime-node` stack found the real tokenizer rejects an empty batch
immediately, which defuses the hang scenario in production. Left in place
unedited (rather than rewritten) so the reasoning trail — what was
believed, what was checked, what changed — stays intact.

**Break case:** `config.crossEncoder.onnx.batchSize` is typed as a plain
`number` (`OnnxCrossEncoderConfig.batchSize?: number`) with no schema/zod
bound found anywhere in the repo (grepped `topK`/`batchSize` across
`src/**`; only `config.ts`/`writer.ts`/the two source files themselves
match — no min-integer validator). The constructor guard is:

```ts
this.batchSize = config.batchSize && config.batchSize > 0 ? Math.floor(config.batchSize) : DEFAULT_BATCH_SIZE;
```

A value strictly between 0 and 1 (e.g. `0.5`) is truthy and `> 0`, so it
survives the guard, then `Math.floor(0.5) === 0`. The batch loop:

```ts
for (let i = 0; i < candidates.length; i += this.batchSize) {
  if (signal?.aborted) { throw ... }
  const batch = candidates.slice(i, i + this.batchSize); // slice(0,0) forever
  ...
}
```

`i += 0` never advances, so `candidates.slice(i, i)` is an empty batch on
**every** iteration, forever, for any `candidates.length > 0`.

**Observed vs expected:** Expected — either a config-load rejection (loud
failure, matching this repo's own ADR-015 posture) or, at worst, a bounded
timeout-based fallback like every other rerank failure mode. **Actual —
first attempt at reproducing this with a real `setTimeout`-based
`AbortController` (the exact mechanism `applyRerank`/`withAbortableTimeout`
uses) never fired the abort at all.** `npx vitest run` against that
scenario had to be killed externally: wrapped in `timeout 45 ...`, it
returned **exit 124** (SIGTERM after the full 45s), and a background
invocation of the same test required an explicit `TaskStop` to end.

**Root mechanism:** the fake backend's `tokenize()`/`run()` resolve via
plain microtasks (no real macrotask/IO in between, which is *more*, not
less, realistic than it sounds if a real ONNX call for an empty batch
returns fast). A tight `await`-chained loop that never yields to a real
macrotask **starves Node's timer phase** — `setTimeout` callbacks
(including `withAbortableTimeout`'s own fallback timer in `rerank.ts`, and
even the test's own external-abort timer) never get a turn to run, because
the microtask queue is continuously replenished. This is not merely "rerank
never completes" (already a known degraded-but-safe mode) — it is a
**timeout-immune hang**: the one safety mechanism this whole file is built
around (`withAbortableTimeout` racing a `setTimeout`) cannot fire, because
the starving code lives *inside* the very `run(signal)` callback the race
depends on.

**Repro (reproduced):** the unbounded version above (killed via `timeout
45` shell wrapper, exit 124, and via `TaskStop` on a background run). A
safe, bounded version substitutes a synchronous call-count guard inside the
fake `run()` (throws at 500 calls) instead of relying on any timer — 500/500
calls all processed the identical empty `slice(0,0)` batch, proving zero
forward progress, deterministically, without depending on a timer that may
never fire.

**Note on real-world severity:** whether this is a full daemon-wide hang in
production depends on whether the real `@huggingface/transformers`/
`onnxruntime-node` `tokenize()`/`model()` calls ever yield through a genuine
libuv macrotask (their native bindings likely do resolve via a real async
callback rather than a synchronous microtask chain) — if so, production
impact is "the timeout still fires, but the process burns CPU
re-tokenizing/re-inferring an empty batch as fast as possible for the
entire `timeoutMs` window on every single search call, forever, never
reranking anything" (a severe, permanent quality+CPU regression, but
bounded). The demonstrated *worst case* (complete timer starvation, no
recovery short of process kill) is real for at least one plausible backend
shape and should not be assumed impossible for the real one without
checking. Either way this is a config-input validation gap: nothing between
`config.yaml` and this constructor rejects a batchSize that can never do
useful work.

---

### ⚠️ CORRECTION (2026-07-23, follow-up) — production severity of the batchSize=0 finding, verified against the REAL backend, not the fake DI seam

Team lead asked me to pin this down against `@huggingface/transformers` +
`onnxruntime-node` directly rather than the permissive fake `loadBackend`
used above. **The result downgrades the finding materially — the original
🔴 HANG verdict does NOT hold in production.** A fix (constructor clamp to
`≥1`) is already dispatched separately; this section is severity
characterization only, appended to the existing artifact rather than
replacing it, so the reasoning trail stays honest about what changed and
why.

**Q1 — does the real native `model()` call yield via a genuine libuv/
threadpool callback?** Yes, confirmed by reading the installed
`onnxruntime-node@1.24.3` source directly
(`node_modules/onnxruntime-node/dist/backend.js:113-125`):

```js
async run(feeds, fetches, options) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try { resolve(inferenceSession.run(feeds, fetches, options)); }
      catch (e) { reject(e); }
    });
  });
}
```

Every real inference call is wrapped in `setImmediate` — a genuine
macrotask (Node's "check" phase). Unlike the fake backend's synchronous-
resolving `async` functions (pure microtask chain, which **does** starve
the timer phase — that part of the original finding is real and
reproducible, just not with this specific bug), `setImmediate` requires a
full event-loop phase cycle. Each cycle still passes back through the
timers phase, so a live `setImmediate`-based spin does **not** starve
`setTimeout` — `withAbortableTimeout`'s own fallback timer would still get
a chance to fire against a real ONNX backend. **Verdict: not a
timeout-immune hang mechanism for this specific code path.**

**Q2 — what does `tokenize([],[])`/`run(empty)` actually do on the real
backend?** Tested live, fully offline (no network, no metered call): loaded
the already-cached local embed snapshot
(`%LOCALAPPDATA%\Astramem\models\onnx\mixedbread-ai\mxbai-embed-large-v1\...`
— same BERT-family tokenizer code path as the cross-encoder's `AutoTokenizer`,
used here purely as a same-library stand-in to avoid downloading the
cross-encoder model itself) via `AutoTokenizer.from_pretrained(snapshotDir)`,
then called `tokenizer([], { text_pair: [], padding: true, truncation: true })`:

```
QA-REPRO: THREW: text array must be non-empty
    at closure._call (.../@huggingface/transformers/dist/transformers.node.mjs:14296:15)
```

**The real tokenizer throws immediately and synchronously on an empty
batch** — it never reaches `backend.run()`/onnxruntime-node at all.
Because `batchSize` flooring to 0 makes `i` never advance, the very
**first** loop iteration already has an empty `candidates.slice(0,0)`
batch — there is no warm-up period of many spinning iterations before this
fires; it throws on iteration 1.

**Q3 — combined verdict:** that thrown error propagates straight out of
`score()` (no try/catch inside the loop), through `withAbortableTimeout`'s
rejection path, into `applyRerank`'s existing `catch` block — the exact
same graceful-degradation path already covered by
`tests/search/rerank.test.ts`'s "falls back to the original order when the
provider throws." **Severity verdict: LOUD (caught) CRASH, immediate,
first-call, not a hang and not a sustained CPU burn.** Production impact of
a misconfigured fractional `batchSize` is "reranking silently and
permanently no-ops to the fused order on every call, at full speed, with
zero added latency" — a real functional regression (same "should fail loud
per ADR-015 instead of silently degrading" flavor as the `topK<=0` finding
above), but **not** an availability or performance risk, and **not** the
timeout-immune hang the fake-backend repro demonstrated. The fake-backend
repro remains valid evidence of a *different, real* risk — that
`withAbortableTimeout`'s guarantee depends entirely on the wrapped
provider code actually yielding to a macrotask, which is not universally
guaranteed for every hypothetical future `CrossEncoderProvider`/backend —
but for *this specific* bug, on *this specific* real backend, the
tokenizer's own input validation defuses it before that risk is ever
exercised.

**3-line verdict:** CPU-burn-till-timeout — **no**. True event-loop hang —
**no** (real backend yields via `setImmediate`, a genuine macrotask, and
the tokenizer rejects an empty batch before any inference call happens
anyway). **Loud crash, immediate, first iteration, already caught by
`applyRerank`'s existing error-fallback path** — yes, confirmed live
against the real cached tokenizer offline.

---

## 🟡 `search.ts` (evidence-excerpt precedence, adjacent to `wire-hit.ts`) — `evidence_span` empty string silently DROPS a populated legacy `evidence`, rather than "shadowing" it with wrong content

**Break case (the reviewer's named hypothesis):** `search.ts`'s evidence
precedence line —

```ts
const evidenceExcerpt = (mem.evidence_span ?? mem.evidence)?.slice(0, MAX_EVIDENCE_EXCERPT_CHARS);
```

— uses `??`, which does not treat `''` as nullish. If `evidence_span` were
ever stored as `''` (not `null`) while a real `evidence` string exists,
`evidenceExcerpt` resolves to `''`, not the legacy string.

**Observed vs expected (reproduced):** Confirmed via direct `MemoryRepo`
insert (`evidence: 'legacy paraphrased excerpt...', evidence_span: ''`)
+ `search()`: `hits[0].evidence` is `undefined` and `'evidence' in hits[0]`
is `false`. **The failure mode is "silently drop the evidence signal
entirely," not "leak the wrong excerpt"** — the push-time guard two lines
below, `...(evidenceExcerpt ? { evidence: evidenceExcerpt } : {})`, is a
*truthy* check, so an empty-string `evidenceExcerpt` is omitted from the
hit shape altogether (same as if neither field existed). This degrades
rerank input quality (no evidence excerpt reaches
`buildRerankCandidateText`) and the wire response (no `evidence` field on
GET /search / MCP tools) for that hit, but does not leak or corrupt data.

**Reachability (this is why it's 🟡, not 🔴):** grepped every writer of the
`evidence_span` DB column — there is exactly one,
`08-embed-index.ts:634` (`evidence_span: evidenceLocation?.span ?? null`),
sourced from `locate-evidence.ts::locateEvidence()`. That function
provably **cannot return an empty-string `span`**: it early-returns `null`
whenever `evidence.trim().length === 0` (line 127) *before* ever computing
a span, tier-1's span is always `needle = evidence.trim()` (already proven
non-empty by that guard), and tier-2 filters candidate lines to
`l.utterance.trim().length > 0` and returns `best.line.utterance.trim()`
(also non-empty by construction). No other call site inserts a memory row
directly (`/remember` and the MCP `remember` tool both go through
`insertWithCreateEvent`, which never sets `evidence_span`). **So this is a
real, reproduced bug in the precedence logic, but currently unreachable via
any production write path** — a latent landmine that would activate the
moment any future writer (a redesigned distill stage, a direct-insert API,
a migration backfill) ever persists `''` instead of `null`/omitted for this
column. Worth a one-line hardening (`mem.evidence_span || mem.evidence`, or
an explicit `!== null && !== ''` check) precisely because the guard that
currently prevents it lives in a different file (`locate-evidence.ts`) than
the code that depends on the invariant (`search.ts`) — nothing enforces
that coupling at the type level.

---

## 🟡 `rerank.ts::applyRerank` — no input validation on `topK`; nonsensical values silently no-op instead of failing loud

**Break case:** `topK: 0`, `topK` negative, `topK` larger than the
candidate count.

**Observed vs expected (reproduced, all three):**
- `topK: 0` → `head = hits.slice(0,0) = []`, `tail = hits.slice(0) = <all
  hits>` → returns hits **completely unchanged**, no throw.
- `topK: -5` → JS negative-slice semantics (`slice(0,-5)` and `slice(-5)`
  both count from the end) also collapse to "head empty, tail = all hits,
  original order" → no throw, no crash — but also no warning that a
  negative `topK` is nonsensical config, unlike, say, a schema validator
  that would 400/throw on config load.
- `topK: 999` (> candidate count) → `head = <all hits>`, `tail = []` → no
  crash, correct behavior (this specific shape is landmine-**closed**: no
  off-by-one, no out-of-bounds access).

None of these crash — this repo's own no-blocking-availability posture
means "silently degrade to unranked order" is arguably the *intended*
failure mode for topK misconfiguration too, consistent with the rest of
the file's philosophy. Flagging as 🟡 because `topK<=0` is indistinguishable
from "rerank is silently doing nothing" with zero signal to the operator —
same class of gap as the batchSize finding above (this file has no config-
input validation of its own, and CLAUDE.md's ADR-015 loud-failure invariant
argues values like this should fail loud rather than degrade silently).

---

## 🟡 `onnx-cross-encoder.ts::OnnxCrossEncoderProvider.score` — `signal` is inert during the ENTIRE model-load phase, not just "between batches" as documented

**Break case:** cold-start / first rerank call while the ONNX model is
still loading (`getBackend()` → `loadBackend()` → real
`AutoTokenizer.from_pretrained` / `AutoModelForSequenceClassification.
from_pretrained` calls) — no `signal` is threaded into any of that.

**Observed vs expected (reproduced):** with a `loadBackend` that takes
150ms and an `applyRerank` `timeoutMs: 20`, the call returns to the caller
in ~33ms (correct fail-open — `withAbortableTimeout` bounds the caller
regardless of what the provider does internally) — **but the abandoned
background load is not cancelled**: `loadCompleted` was `false`
immediately after `applyRerank` returned, then `true` ~230ms later,
confirming the load ran to completion, unabated, after the request had
already moved on.

**Why this matters beyond the documented caveat:** the doc comment on
`score()`'s `signal` param says cancellation "is checked BETWEEN batches...
a signal that fires mid-batch will not interrupt that in-flight `run()`
call" — technically true, but undersells the real gap: **the model-load
phase (usually the slowest part of a cold call — network fetch or disk
read of tens of MB) is not "a batch," it happens entirely before the loop's
first `signal?.aborted` check, and is never abortable at all.** This
matches landmine #3's "confirmed fail-open for the caller" expectation
(closed — verified), but is a real resource-leak/observability gap: a
génuinely stuck first load (slow network, no OS-level connection reset)
means `backendPromise` stays memoized-pending forever (the `.catch` that
clears it to `null` only fires on outright *rejection*, never on a hang),
so **every subsequent rerank call for the rest of the process lifetime
also pays the full configured `timeoutMs` before falling back** — there is
no retry-with-backoff or circuit-breaker; the daemon just silently eats
`timeoutMs` of latency on every search call, forever, until restart.

---

## Negative / landmine-closed results (one line each)

- **`rerank.ts::buildCrossEncoderProvider` — no mock-vs-onnx silent swap
  within this file (static).** Every branch is an explicit `config.provider
  === 'mock' | 'onnx'` check; an unrecognized/undefined `provider` value
  falls through to the `http` branch and *throws* if `sidecarUrl` is unset
  — fails loud, never silently defaults to mock. The known landmine (eval
  harness `run.mts` defaulting to the Jaccard mock with no `--rerank` flag)
  lives entirely outside this file's surface; found no second instance of
  the pattern inside `rerank.ts`/`onnx-cross-encoder.ts`/
  `onnx-rerank-registry.ts`.
- **`onnx-cross-encoder.ts` — corrupt/missing model artifact fails open
  (static + existing tests).** A throw from `loadTransformersCrossEncoderBackend`
  (missing snapshot + `modelPath` set, or a genuinely corrupt file causing
  `from_pretrained` to reject) propagates through `getBackend()` (which
  resets `backendPromise = null`, allowing retry) up through `score()` into
  `applyRerank`'s catch block → clean fallback to un-reranked order.
  Already covered by `tests/search/rerank.test.ts`'s "falls back... when
  the provider throws" and `tests/search/onnx-cross-encoder.test.ts`'s "a
  failed load is not memoized" — confirmed fail-open, never blocks
  retrieval.
- **`src/server/lib/deadline.ts` / `src/server/routes/search.ts` — GET
  /search has no `withDeadline` wrapper at all (only POST /recall does);
  neither route's deadline actually cancels the underlying work on timeout
  (static, adjacent to scope but relevant to "does rerank hang the
  route").** Not a rerank-specific bug: `applyRerank`'s own
  `withAbortableTimeout` structurally bounds the rerank stage regardless of
  `withDeadline`'s presence, so GET /search's missing wrapper does not
  reopen a rerank hang on its own. But it means (a) `withDeadline`'s
  30s POST /recall backstop is itself non-cancelling (its own doc comment
  admits this — "Does NOT cancel `fn()` on timeout... its result is
  discarded" — so a timed-out request's search()/rerank work keeps
  consuming CPU in the background even after the client gets its 504), and
  (b) if a *future* stage is ever added to `search()` without the same
  `withAbortableTimeout` discipline `rerank.ts`/`decompose.ts`/
  `query-rewrite.ts` all follow, GET /search has zero backstop to catch it.
  Worth a follow-up ticket, not a rerank-path regression today.
- **`rerank.ts::applyRerank` clamping/missing-id/timeout/error fallback
  paths (reproduced via existing suite, re-verified) — all correct.** Score
  clamping to [0,1], missing-candidate-id fallback to fused score, and both
  whole-call fallback paths (timeout via `RerankTimeoutError`, provider
  throw) all behave exactly as documented; `withAbortableTimeout` itself
  cannot double-settle (native `Promise` executor semantics make a second
  `resolve`/`reject` call after the timer fires a safe no-op) — no
  unhandled-rejection or double-fallback hazard found.
- **Adversarial abstention boundary (item #5) — characterization only, not
  a bug in this file's surface.** `applyRerank` has **no absolute-score
  floor** anywhere — it always promotes the *relatively* highest-scoring
  candidate in the topK window to position 0, regardless of how low that
  candidate's absolute `rerank_score` is (a set of all-irrelevant
  candidates still produces a "winner"). The raw score IS exposed
  end-to-end for a downstream consumer to gate on
  (`explanation.signals.cross_encoder.final` in `search.ts`'s merge step),
  but nothing in `rerank.ts`, `search.ts`, or the wire layer currently
  applies such a floor — the LEDGER's adversarial regression
  (0.872→0.723) is therefore explainable as "no abstention gate exists
  downstream of rerank," not as a defect in the rerank stage's own scoring
  math. Fixing it (if desired) is an answerer/fusion-layer decision, out of
  this file's ownership.

---

## Summary — dispatch checklist

| # | Landmine | Status |
|---|---|---|
| 1 | mock-vs-onnx silent swap (other call paths) | Closed within surface (static) |
| 2 | 30s route deadline enforcement | Rerank itself bounded (structural); route-level deadline gap noted as adjacent finding (static) |
| 3 | missing/corrupt ONNX model → fail-open | Closed (static + existing tests) |
| 4 | `evidence_span ?? evidence` empty-string shadow | **Reproduced** — real bug, currently unreachable in prod (🟡 latent) |
| 5 | adversarial abstention / no score floor | Characterized, not a bug in this surface |
| 6 | topK edge cases (0 / negative / > candidates) | **Reproduced** — no crash, but silent no-op with zero operator signal (🟡) |
| — | fractional `batchSize` in (0,1) | Fake-backend repro showed a true timeout-immune hang (external kill required); **verified against the real `@huggingface/transformers`/`onnxruntime-node` stack and downgraded** — the real tokenizer throws immediately on an empty batch (`"text array must be non-empty"`), which `applyRerank` already catches via its existing provider-throw fallback. **Production verdict: loud (caught) crash, first-call, no hang, no CPU burn** — see "⚠️ CORRECTION" section. Fix (constructor clamp to ≥1) already dispatched separately; still worth keeping regardless, since a config-validation gap is real even though this specific hang path isn't reachable with the real backend. |
