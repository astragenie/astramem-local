---
status: needs_fix
---

# Review Result — SLICE-423 / FEAT-462 slice B (detach + PID/port manifest)

- Worktree: `C:\work\mega\astramemory-local-worktrees\w462b`, branch
  `feat/feat-462b-detach`, commit `42ad499` vs `main`/`75c2056` (v0.13.0)
- Reviewer: independent review (read-only, no edits made, worked only in this worktree)
- **Verdict: NEEDS_FIX** — one MEDIUM-HIGH finding: `killManifestDaemons` has zero
  protection against PID reuse, the exact hazard this scoped-kill mechanism exists to
  prevent (the 2026-07-10 incident CLAUDE.md documents was precisely a wrong-process
  kill). One MEDIUM finding: the README documents the manifest/status mechanism but
  not a concrete "find and kill a stuck detached run" operator recipe. Everything
  else — the double-detach guard, atomic writes, the kill-then-resume handshake test,
  and byte-compat of the default path — is genuinely solid, verified directly
  (including a live execution diff and an empirical Windows rename test). The full
  suite showed intermittent, non-reproducible failures across repeated runs,
  reported transparently below rather than glossed over.

## Finding 1 (MEDIUM-HIGH — real, verified): `killManifestDaemons` has no PID-reuse protection — the exact failure class this mechanism exists to prevent

**File: `scripts/eval/shared/daemon-manifest.ts:72-86`.** `killManifestDaemons`
calls `process.kill(entry.pid, signal)` directly on whatever PID is stored in the
manifest — no process-identity cross-check (name, start time, or "is this PID still
bound to the recorded `port`") and no manifest-staleness check (age of
`manifest.updated_at`) before signaling. If a manifest's recorded daemon has since
died and the OS has reused that PID for an unrelated process — an ordinary,
well-known OS behavior, and a real risk on the kind of long-running, busy, shared
box this repo's own CLAUDE.md describes ("this box runs the production daemon, eval
shard daemons, Ollama, and sibling agents' processes") — a later invocation against
a stale manifest sends a live signal to that innocent, unrelated process. This is
**precisely** the failure shape CLAUDE.md's Do-NOT section records as having already
happened once (the 2026-07-10 incident that motivated this entire FEAT), just via a
different mechanism (PID reuse instead of an image-name sweep).

**Confirmed this is a latent, not yet actively wired, risk in this specific slice**:
grepped every non-test reference to `killManifestDaemons` — it is exported but never
called from `run-smoke.mts`/`run.mts` (no `--kill`/`--cleanup` CLI flag ships in this
slice); the only caller today is its own test suite (`daemon-manifest.test.ts`,
`detach-kill-resume.test.ts`), both of which call it immediately after a live spawn,
never against a stale manifest. So there is no *shipped* command an operator could
run today that would hit this. But this is exactly the library function the README
tells future cleanup tooling to build on ("a cleanup script reads this file and
signals only these PIDs") — the hazard is baked into the one function everything
downstream will reuse, with zero built-in safety net for the case that function
exists to eventually serve.

**Recommended mitigation (cheap, doesn't require new infrastructure)**: before
signaling, verify the process is still plausibly the intended daemon — the manifest
already records `port`; checking that the PID is still listening on (or was recently
observed at) that port, or checking manifest `updated_at` age against a
"still-plausibly-live" threshold and refusing/warning on stale manifests, would close
most of the gap cheaply. This doesn't need to be perfect (a TOCTOU race is
inherent to any PID-based kill), just enough to catch the common case of "this
manifest is from an hours/days-old dead run." Recommend closing before any real
cleanup tooling is built on top of `killManifestDaemons`, given how directly this
mirrors the incident the whole FEAT-462 effort exists to prevent.

## Finding 2 (MEDIUM — real, non-blocking): detach orphan story is documented at the mechanism level, not as a concrete operator recipe

Confirmed via diff that both `longmemeval/README.md` and `locomo/README.md`
document the *pieces* — `run-status.json`'s shape and `--status` flag, and
`daemon-manifest.json`'s shape and that "a cleanup script reads this file and
signals only these PIDs" — but neither README walks through an explicit,
copy-pasteable recipe for "your detached run seems stuck, here's exactly what to
check and run to confirm it and clean it up." An operator has all the raw pieces
(read `run-status.json` to see if `updated_at` has stalled, read
`daemon-manifest.json` for the PIDs, then... write their own kill script?) but no
worked-through playbook. Given `--detach`'s whole point is surviving process/session
boundaries specifically so operators check on it *later*, possibly a different
person, a concrete "if stuck, do X" section would materially close the gap between
"the mechanism exists" and "an operator under time pressure can actually use it."
Not a blocker — the underlying files/functions are correct and documented at the API
level — but worth adding before this is the only tool an on-call person reaches for
during a real stuck-run incident.

## 3. Atomic status writes on Windows — verified empirically, not just by pattern-matching against precedent

Read `run-status.ts` and `daemon-manifest.ts`: both use the identical tmp-file +
`renameSync` + cleanup-on-error pattern as `src/config/writer.ts`'s `writeConfig`
(FEAT-433's established atomic-write technique in this repo). The specific concern
raised — `renameSync` over an *existing* destination file historically failing with
`EPERM`/`EEXIST` on some Windows/Node combinations — is a real, historically-known
Node.js-on-Windows quirk, so I didn't just trust the precedent; I tested it directly
on this actual machine: wrote to a temp file and `renameSync`'d over an existing
destination **20 times in a row** (simulating the repeated throttled-patch pattern
`run-status.ts` actually produces during ingest), under both real Node (v24.16.0)
and Bun's Node-compat runtime (v24.3.0) — zero failures, every rename succeeded and
the final content was correct. Not reproducible on this repo's actual target
runtime; matches the already-proven-safe `writer.ts` precedent.

## 4. Double-detach re-entry — confirmed robust via defense-in-depth, not just argv-stripping

Read `evaluateDetachDecision`/`isDetachedChild`/`buildDetachedChildArgs` directly.
The **primary** guard is an environment variable (`ASTRAMEM_EVAL_DETACHED_CHILD=1`)
set on the child's spawn env and checked via `isDetachedChild()` —
`evaluateDetachDecision`'s condition is `if (!opts.detachRequested ||
opts.alreadyDetached) return { action: 'run-inline' }`, an **OR**, so
`alreadyDetached` alone forces inline execution regardless of whether
`--detach` is still present in argv. `buildDetachedChildArgs` also strips
`--detach` from the child's argv, but this is explicitly documented (and
structurally is) a redundant belt-and-suspenders measure, not the load-bearing
guard — even a hypothetical bug that failed to strip `--detach` couldn't cause
infinite re-detach recursion, because the env-var check is unconditionally
decisive. Genuinely well-designed against this specific failure mode.

## 5. Kill-then-resume handshake test — confirmed it exercises the real manifest path

Read `longmemeval/detach-kill-resume.test.ts` directly: it calls the real
`writeDaemonManifest`/`readDaemonManifest`/`killManifestDaemons` functions — the kill
is performed via `killManifestDaemons(manifest, 'SIGKILL')` against a manifest object
obtained through an actual disk read, not `killDaemon(daemon1, ...)` on the
in-process `DaemonHandle` (that direct-handle path is used only in `afterEach`
cleanup for whatever the test itself didn't already kill). The test also
incidentally confirms good manifest hygiene on resume: it asserts the *new*
manifest (written after respawning) carries the new daemon's PID and explicitly
checks it does **not** equal the old (now-dead) PID — i.e., the manifest genuinely
gets refreshed on resume rather than carrying forward stale entries in the normal
resume cycle. This is a meaningful, real mitigation for the *normal* usage pattern
(kill-then-immediately-resume-and-refresh) — Finding 1's residual risk is
specifically about a manifest that's gone stale *without* an intervening resume
(an abandoned or long-since-completed run dir), which this test doesn't (and isn't
designed to) cover.

## 6. Byte-compat of the default (non-detach) path — verified with a live execution diff

Built a throwaway comparison worktree at `75c2056` (removed after) and ran
`run-smoke.mts` with a synthetic empty dataset at both commits, forcing the same
early, deterministic crash point (`loadDataset`'s non-empty-array check) in both.
stdout is byte-identical apart from the intentionally-different `--run-dir` path
and the (expected) differing stack-trace file paths/line numbers between the two
worktree locations — no new console output appears before the crash point in either
version, confirming the new `evaluateDetachDecision`/`patchRunStatus`/
`writeDaemonManifest` wiring produces zero observable stdout noise on the default
path; it only adds silent, additive files (confirmed `run-status.json` appeared in
the new run's dir, matching the documented always-on precedent from slice A).

## 7. Gates

- `bunx tsc --noEmit`: clean, no output.
- `bunx vitest run scripts/eval/`: **17 files / 140 tests passed, 0 failed** —
  matches the builder's claimed numbers exactly.
- `bun run test` (full suite, in-worktree): **reported transparently, not glossed
  over** — ran the full suite **9 times total** across this review (3x via `bun run
  test`, 6x via `bunx vitest run --reporter=json` to try to pin down specifics).
  **7 of 9 runs were clean** (208 files / 2454 passed / 6 skipped / 0 failed,
  matching the builder's claimed numbers exactly). **2 of 9 runs showed
  intermittent failures** (one run: 1 file / 1 test failed; another: 2 files / 3
  tests failed) that I was unable to reproduce on demand or pin to specific test
  names — by the time I switched to the JSON reporter to capture failure detail,
  every subsequent run (6 in a row) came back clean. This pattern — rare,
  non-deterministic, disappearing on rerun, under a 2400+ test parallel suite run —
  matches this exact repo's own **already-documented pre-existing flakiness class**
  under parallel load (an earlier review this session independently confirmed a
  `tests/scripts/post-merge-rebuild.test.ts` timeout flake under the same
  conditions, unrelated to whatever diff was under review at the time). I cannot
  rule out with certainty that this slice's new real-process-spawning tests
  (`detach.test.ts`'s spawn-detached integration test, `daemon-manifest.test.ts`'s
  real-process kill tests) contribute to the flakiness given they do spawn real
  child processes — but the majority-clean result and the inability to catch a
  consistent failure signature is more consistent with pre-existing
  suite-under-load flakiness than a deterministic bug in this diff's own logic.
  Flagging this transparently rather than only reporting the clean runs; recommend
  the team treat it as a known-class flake unless it starts reproducing
  consistently, in which case the new real-spawn tests would be the first place to
  look.

## Recommendation

Fix Finding 1 (PID-reuse protection in `killManifestDaemons`) before any real
cleanup tooling is built on top of it — it's the exact failure mode this whole
FEAT-462 effort exists to close, currently unmitigated in the one function future
tooling will reuse. Finding 2 (operator playbook) is real but lower priority — a
README addition, not a code change. Everything else — the double-detach guard,
atomic-write safety (verified empirically on this actual Windows/Node combination),
the kill-then-resume handshake's use of the real manifest path, and byte-compat of
the default invocation (verified via a live execution diff) — is genuinely solid.
