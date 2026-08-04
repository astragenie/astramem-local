# Bedrock Migration — Wave Plan

> **Scope:** move eval **answering and judging** off Azure OpenAI onto AWS Bedrock.
> **Date:** 2026-08-04 · **Baseline:** v0.22.0
> **Parent:** [`remediation-plan-2026-08-04.md`](./remediation-plan-2026-08-04.md)
> **Not in scope:** the runtime daemon's own LLM provider (`src/providers/llm/`). That is a
> separate, larger effort — see "Deliberately out of scope" at the end.

---

## Why this is not a find-and-replace

Three facts establish the shape of the work.

1. **The eval harness bypasses the provider abstraction entirely.** `scripts/eval/shared/azure-client.ts`
   is a standalone `fetch` client that never imports from `src/`. `src/providers/llm/azure-openai.ts`
   is a different code path used only by the daemon. Adding `src/providers/llm/bedrock.ts` would
   switch the daemon and do **nothing** for judging.
2. **Bedrock cannot ride the `openai-compatible` adapter.** Converse uses AWS SigV4 signing, not
   `Authorization: Bearer`, with a different request envelope and model ARNs. It needs its own client.
3. **One of the call sites is Python.** `scripts/eval/longmemeval/judge/evaluate_qa_azure.py` is a
   hand-forked upstream judge patched for `AzureOpenAI`. Migrating it means `boto3` — a second
   language and SDK, not a mechanical edit.

## ⚠️ The risk that shapes the sequencing

**Changing the judge model silently invalidates comparability with every archived run.**

Every number in `docs/eval-runs/LEDGER.md` was produced by a `gpt-5-mini` judge. A Bedrock judge
will not score identically. If we cut over and then run an eval, we cannot tell whether a delta is
the change we made or the judge we swapped — the same confound that already makes the codex
day-variance problem so expensive (see the adversarial review, Charge 7).

**Therefore the cutover is gated on a dual-judge calibration, not followed by one.** Wave 4 exists
for this and is not optional.

---

## Wave 1 — Foundations (3 tracks, fully parallel)

No track touches another's files. All three land before any call site moves.

| Track | Deliverable | Files | Owner |
|---|---|---|---|
| **1A** | Converse client — request/response mapping, streaming off, `ThrottlingException` retry with backoff (Bedrock does **not** return HTTP 429) | `scripts/eval/shared/bedrock-client.ts` (new) | builder |
| **1B** | Credential + region + model resolution, mirroring the Azure precedent (env first, CLI-login fallback, **never written to disk**) | `scripts/eval/shared/bedrock-config.ts` (new) | builder |
| **1C** | **The seam** — one interface both clients satisfy, so call sites become backend-agnostic and switchable by env var | `scripts/eval/shared/judge-client.ts` (new) | builder |

**1C is the load-bearing one.** Without it, Wave 2 is 15 simultaneous edits to files that also need
to keep working on Azure. With it, Wave 2 becomes mechanical and each call site is independently
revertible.

Interface shape (both backends implement, `azure-client.ts` gets a thin wrapper — it is **not**
rewritten):

```ts
export interface JudgeClient {
  readonly backend: 'azure' | 'bedrock';
  readonly modelLabel: string;              // goes into run-manifest for provenance
  complete(req: JudgeRequest): Promise<JudgeResult>;
}
```

`modelLabel` is required, not cosmetic: every archived run must record which judge produced it, or
Wave 4's comparison is unreproducible and we repeat the mistake that lost `0.5549`.

**Wave 1 exit criteria**
- `bedrock-client.ts` completes a real Converse call against a live model, proven by a test that
  fails without credentials rather than skipping silently
- Throttling retry demonstrated against a simulated `ThrottlingException`
- `azure-client.ts` behaviour is **unchanged** — existing tests green, no eval regression

---

## Wave 2 — Call-site migration (4 tracks, parallel, one worktree each)

Only starts once 1C has landed. Each track owns disjoint files, so they cannot conflict.

| Track | Call sites | Notes |
|---|---|---|
| **2A** | `locomo/answer.mts`, `locomo/judge.mts`, `locomo/compare.mts` | The primary path. Highest value, do first. |
| **2B** | `longmemeval/answer.mts`, `longmemeval/judge.mts` (TS only) | The `.py` fork is Wave 3, not here. |
| **2C** | `extraction-bench/run-bench.mts`, `run-proof-phase.mts`, `run-chunksize-sweep-fixtures.mts`, `lib/azure-reasoning-provider.ts` | `azure-reasoning-provider.ts` may need its own Bedrock twin. |
| **2D** | `oracle/*` — harness, rejudge, mem0-judge, oracle-factorial, `answerers/{current,canonical,mem0,strong,zep-match}.mts` | Largest file count, lowest risk (A/B harness, not a shipped path). |

**Every track keeps Azure working.** Migration means routing through `JudgeClient` and selecting
the backend by env var — not deleting the Azure path. Azure stays until Wave 4 says otherwise.

**Wave 2 exit criteria**
- Every call site runs on either backend by env var alone
- Default remains **Azure** — no behaviour change yet
- `bun run test` green

---

## Wave 3 — The Python fork (serial, own track)

`scripts/eval/longmemeval/judge/evaluate_qa_azure.py` → a `boto3` sibling.

Deliberately isolated: different language, different SDK, different failure modes, and it is a
**fork of an upstream script** — so the diff against upstream must stay legible or the next upstream
sync becomes guesswork. Document what was changed and why, in the file.

Runs parallel to Wave 2 if a second builder is available; it shares no files with any 2x track.

---

## Wave 4 — Dual-judge calibration (gates the cutover)

**This is the wave that makes the migration safe, and it cannot be skipped.**

1. Take one **already-archived** run directory with known scores.
2. Re-judge it with **both** backends — same answers, same questions, only the judge differs.
3. Compare per-category and overall F1. Quantify the delta.
4. Record the result in `docs/eval-runs/` as a first-class artifact, with both `modelLabel`s.

**Decision rule:**

- **Delta within noise** → cut over, and note in `LEDGER.md` the run from which the judge changed.
- **Delta material** → do **not** silently cut over. Either keep Azure for continuity on the
  historical series and use Bedrock for new work, or re-judge the baseline set on Bedrock to
  establish a new comparable series. Both are acceptable; pretending the numbers are comparable is not.

⚠️ Any number produced after cutover is **not comparable** to a pre-cutover number unless this wave
says it is. `LEDGER.md` needs a judge-backend column regardless of outcome.

---

## Wave 5 — Cutover and Azure retirement

- Flip the default backend to Bedrock
- Keep Azure reachable behind the env var for one release as a rollback path
- Remove the hardcoded Azure subscription / resource group / account constants
  (`scripts/eval/shared/config.ts:22-24`) **only** once Wave 4 has passed and one full eval has run
  green on Bedrock

---

## Sequencing

```
Wave 1  ── 1A ─┐
           1B ─┼─→ (1C is the gate)
           1C ─┘
                 │
Wave 2  ─────────┼─→ 2A ─┐
                 │   2B ─┤
                 │   2C ─┼─→ Wave 4 (dual-judge calibration)
                 │   2D ─┘        │
Wave 3  ─────────┴─→ .py ─────────┘
                                   │
                            Wave 5 (cutover, gated on Wave 4)
```

**Critical path:** 1C → 2A → Wave 4 → Wave 5. Everything else runs alongside it.

---

## Why this is urgent, stated plainly

The Azure key resolves by shelling out to `az cognitiveservices account keys list` against a
**hardcoded** subscription, resource group and account (`scripts/eval/shared/config.ts:22-24`), with
no fallback. Verified working 2026-08-04 (HTTP 200).

But every eval run now depends on a live `az login` against infrastructure being decommissioned.
When that subscription goes away, **every eval loses its answerer and judge simultaneously**, and
fails at three constants nobody has recorded as a dependency. That is an unscheduled outage with no
date attached.

---

## Deliberately out of scope

- **`src/providers/llm/bedrock.ts`** — moving the *runtime daemon* off Azure. A separate ask. It
  shares the Converse mapping work with 1A but must implement the full `LLMProvider` interface
  (`chat`/`health`, `ChatUsage` with computed `usd`, a Bedrock `pricing.ts` entry). Track separately
  if the daemon is also meant to move.
- **Refactoring the eval harness onto `src/providers/`.** Larger, riskier, and would couple eval
  runs to daemon provider changes. The `JudgeClient` seam gets the benefit without the coupling.
