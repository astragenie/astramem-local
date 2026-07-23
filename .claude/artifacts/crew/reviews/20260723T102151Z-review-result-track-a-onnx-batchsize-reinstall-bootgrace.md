---
review_decision: PASS
scope: track/a (astramem-local, service hardening)
commit: 6b718595
base: feat/retrieval-overhaul (b2b9f008)
worktree: C:/work/mega/astra-wt/track-a
files:
  - src/search/onnx-cross-encoder.ts
  - src/cli/reinstall.ts
  - tests/search/onnx-cross-encoder.test.ts
  - tests/cli/reinstall.test.ts
reviewer: independent review agent (read-only)
---

# Review: Track A — onnx batchSize loud-clamp + reinstall boot-grace verify-health

## Verdict: PASS (no blocking findings; two non-blocking flags, one info nit)

## Task 1 — onnx-cross-encoder batchSize clamp (issue #17)

**NaN-safe guard reasoning: CONFIRMED CORRECT.**

- `flooredBatchSize = Math.floor(config.batchSize ?? 0)`; warn-gate is
  `config.batchSize !== undefined && !(flooredBatchSize >= 1)`; value-select is
  `flooredBatchSize >= 1 ? flooredBatchSize : DEFAULT_BATCH_SIZE`.
- Traced every case by hand: `undefined` → no warn, defaults silently (correct —
  omission isn't a misconfig); `16` → no warn, honored; `0.5`/`0`/`-1` → warn +
  fallback; `NaN` → `Math.floor(NaN)=NaN`, `NaN !== undefined` is `true`,
  `!(NaN >= 1)` is `!(false)` = `true` → **warns correctly**. Had the guard instead
  been written as `flooredBatchSize < 1`, `NaN < 1` evaluates `false` (all NaN
  comparisons are false), so the warn would have silently not fired for the NaN
  case while the fallback still silently applied — exactly the bug the author's
  comment describes avoiding. The two predicates (`!(x>=1)` for warn, `x>=1` for
  value) are the same comparison, not two independently-drifting checks — good.
- Clamp math always yields an integer ≥ 1 to `score()`'s loop: `Math.floor` is
  applied before any comparison, so no fractional value escapes; the only two
  outcomes are the floored value (when ≥1) or `DEFAULT_BATCH_SIZE` (16). No 0
  or negative value can reach `this.batchSize`.
- Tests assert both effects together, not just one: `runBatchCountFor` proves
  the fallback batch **count** (`ceil(20/16)=2` batches) *and*
  `warnMock.toHaveBeenCalledTimes(1)` with `toMatchObject({configured_batch_size,
  effective_batch_size})` for 0.5/0/-1/NaN, plus explicit "no warn" assertions
  for a valid value (1) and an omitted config. Good coverage of the crux.
- Termination regression test (`providerWithFakeBackend({ batchSize: 0.5 })`,
  asserts `score()` resolves): confirmed **load-bearing by analysis** — the fake
  backend's `tokenize`/`run` are plain `async` functions with no macrotask
  boundary (no `setImmediate`/timer), so under the pre-fix guard
  (`config.batchSize && config.batchSize > 0 ? Math.floor(...) : DEFAULT`),
  `batchSize=0.5` passes `>0`, floors to `0`, and `score()`'s
  `for (i=0;i<len;i+=0)` never advances `i` — an unbounded microtask loop that
  vitest's default timeout would kill as a failing test, not a pass. This is a
  real regression guard, not a tautology. (Did not literally revert the source
  to fire the test, per the read-only constraint on this review — verified by
  code-path analysis instead, which is conclusive here since the loop shape is
  simple and deterministic.)
- Verified the severity-downgrade claim against the real fallback path: `score()`
  throwing propagates into `applyRerank`'s `catch` (`src/search/rerank.ts:407`),
  which logs `'rerank stage fallback to un-reranked order'` at WARN and returns
  the un-reranked hits — confirms "degrades to fused order," not a hang.
  Minor wording nit (non-blocking): calling the pre-fix failure "silent" is a
  slight overstatement — `rerank.ts`'s catch already logged *something* on
  every call — but it's fair in the sense that nothing in that generic log
  named `batchSize` as the cause; the new constructor-time WARN is what makes
  the misconfig specifically attributable, which is the real value-add.

## Task 2 — reinstall verify-health boot-grace

**Fast-fail correctness (checklist item 1): CONFIRMED CORRECT.** Traced
`waitForHealthWithBootGrace`'s loop: hard-cap is checked before *and* after each
chunk; a failed chunk falls through to `readLock` + `isAlive` only if the hard
cap hasn't been hit; dead/missing lock → returns `daemon-dead` immediately
(after exactly one failed chunk, not the full budget) — confirmed by the two
"fails FAST" unit tests (`waitForHealthImpl` called exactly once). A live
holder loops for another chunk, bounded by `bootHardCapMs()`. Chunk-size
clamping (`Math.min(opts.chunkMs, remaining)`) on the final chunk is correct
and covered by a dedicated test with a non-exact-multiple hard cap.

**Two non-blocking flags:**

1. **[MEDIUM] Liveness check doesn't verify daemon identity, only PID
   liveness — a narrower version of this repo's own documented PID-reuse
   hazard class.** `isDaemonPidAlive(lock.pid)` (and the injected
   `pidAliveImpl`) only asks "is *some* process running at this PID," not "is
   it *the daemon instance we started*." This repo already has the fix for
   exactly this problem: `instance-lock.ts`'s `checkHolderIdentity` (and
   `watchdog-probe.ts`'s own boot-grace mechanism, which this change's doc
   comment cites as its direct model) key off `${pid}:${startedAt}` via the
   already-exported `getProcessStartTime`, specifically because a bare PID
   check can't distinguish the tracked instance from an unrelated process
   that later reuses the same PID. `waitForHealthWithBootGrace` reads
   `lock.startedAt` (it's right there in `LockInfo`) but never compares it
   against anything — it re-reads whichever lock is current each iteration
   and only pid-checks it. Concretely: if the daemon `reinstall` just started
   dies and, before the *next* boot-grace chunk (up to ~90s later, repeating
   for up to 20 min), the OS recycles that exact PID for an unrelated
   process, `isDaemonPidAlive` reports "alive" and the loop presumes
   "still booting" instead of failing fast — silently regressing to
   waiting out the full `bootHardCapMs()` (20 min default) for a genuinely
   dead daemon, which is precisely the failure mode this fix's fast-fail path
   exists to avoid. Not blocking: it doesn't reintroduce an unbounded hang
   (the hard cap still fires eventually) and the exposure window (PID reuse
   within a ~90s-to-20min gap) is narrow. But the fix for it is cheap and the
   primitive already exists in this exact codebase — worth closing before
   this ships, or at minimum tracking as a known gap.
2. **[LOW-MEDIUM, UX, flag-not-block as requested] No progress feedback
   during the (now up to 20-minute, vs. previous 90s) wait.**
   `waitForHealthWithBootGrace` is pure/silent by design (good for
   testability), and the caller (`reinstallCommand` / `repointStopStartVerify`)
   only logs once, after the *entire* wait resolves or fails — nothing prints
   per-chunk. Reusing `BOOT_HARD_CAP_SEC` for parity with the watchdog is
   reasonable (same worst-observed boot time applies to both paths), but the
   watchdog is a passive background process with no one watching a terminal;
   `reinstall` is a foreground CLI command a human is very likely waiting on
   synchronously. Twenty minutes of total silence reads as "hung" to an
   operator who doesn't know this fix shipped, and inviting a Ctrl+C
   mid-wait defeats the point of the fix. Suggest (non-blocking): a short
   progress line per chunk (elapsed time + "daemon.lock holder pid=N alive,
   still booting"). The `ASTRA_MEMORY_REINSTALL_BOOT_HARD_CAP_MS` env override
   is a reasonable escape hatch for operators who want a shorter cap in the
   meantime.
3. **Duplicated `isDaemonPidAlive`**: confirmed byte-for-byte equivalent
   semantics to `instance-lock.ts`'s private `pidAlive` (same
   `process.kill(pid,0)` + ESRCH/EPERM handling). Acceptable per this
   change's file-scope guardrail; low drift risk since the logic is trivial,
   but if `instance-lock.ts`'s version ever changes (e.g. adds a third errno
   case), this copy won't follow automatically — worth a `// keep in sync
   with instance-lock.ts's pidAlive` marker on both sides if that's cheap to
   add later.
4. Hard-cap clamp / already-exhausted (`hardCapMs: 0`) edge case: covered by
   a dedicated test (`waitForHealthImpl` never called, returns immediately
   with `gaveUpReason: 'hard-cap'`). Confirmed correct.

## Verification run (not trusted from the handoff message — executed directly)

- `bunx tsc --noEmit -p tsconfig.json` → clean, exit code 0.
- `npx vitest run tests/search/onnx-cross-encoder.test.ts tests/cli/reinstall.test.ts`
  → **58/58 passed** (24 + 34), not the claimed 62/62. All tests pass; the
  count in the handoff is simply wrong — flagging so a wrong number doesn't
  propagate into the ledger/synthesis. [INFO, non-blocking]

## Scope / base discipline

- `git diff feat/retrieval-overhaul..track/a --stat` touches exactly the 4
  files named in the task: `src/search/onnx-cross-encoder.ts`,
  `src/cli/reinstall.ts`, `tests/search/onnx-cross-encoder.test.ts`,
  `tests/cli/reinstall.test.ts`. `config.ts` diff is empty — `crossEncoder`
  defaults untouched.
- Main checkout `C:/work/mega/astramem-local` not touched by this track
  (verified from within the worktree only; scope of this review is the
  worktree).
- `git stash list` empty, `git status --porcelain` empty — no stray state
  from the disclosed stash slip; worktree clean.

## Summary

Both fixes are correct on their stated crux (NaN-safe batchSize floor+clamp;
fast-fail-when-dead / extend-when-alive boot-grace polling). Recommend
addressing the PID-identity gap (finding 1) before/soon after merge given how
cheap the existing primitive is to reuse, and consider the progress-logging
UX nit (finding 2) — neither blocks this PASS.
