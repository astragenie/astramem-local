---
feature: FEAT-458
slice: S1
gate: design
authority: ADR-013 human security review (2026-07-10) + DEC-014 operator override (2026-07-12)
date: 2026-07-12
status: completed
decision: design_gate_closed
self_approval: false
---

# FEAT-458 S1 — design-gate closure

## What this artifact closes

The **design portion** of FEAT-458 slice 1 (S1-AC-4) is CLOSED as of
**2026-07-12**, on the authority of:

1. `docs/adr/ADR-013-llm-proxy-auto-capture.md` — Accepted 2026-07-10, human
   security review, all five open questions answered in its "Review
   decisions" section.
2. `.claude/artifacts/loop/decisions/DEC-014.md` — Accepted 2026-07-12,
   explicit operator override of ADR-013's own build gate.

This closes the *security/policy design* layer of S1: the STRIDE model, the
failure-mode posture, the credential-handling model, and — separately and
explicitly — who authorized building ahead of the runtime bake gate, and on
what basis.

**This artifact does NOT assert that all of S1-AC-4's literal conditions are
satisfied yet.** FEAT-458.md's S1-AC-4 text requires "FEAT-467's design, the
`proxy.*` config surface, and the bench harness skeleton are all in place"
before slice 2 may open. As of this writing:

| S1-AC-4 component | Status | Evidence |
|---|---|---|
| FEAT-467 (invalidate() reversal/audit) | **Done** | `.claude/artifacts/loop/backlog/done/FEAT-467.md` |
| Design (ADR-013 + DEC-014) | **Closed** (this artifact) | ADR-013 Review decisions; DEC-014 |
| `proxy.*` config surface + doctor WARN row + disable→purge parity (S1-AC-2) | **In progress**, not yet merged to main | Being built on branch `feat/feat-458-s2-proxy-core-v2` (worktree `w458core`) as part of the current Wave 1 parallel run; no review artifact for this track exists yet in `.claude/artifacts/crew/reviews/` as of 2026-07-12T23:30Z |
| Bench harness skeleton under `scripts/eval/proxy-bench/` (S1-AC-3) | **In progress**, not yet merged to main | `scripts/eval/proxy-bench/` does not exist on `main` as of this writing; being built on branch `feat/feat-458-s1-proxy-bench` (worktree `w458bench`) as part of the current Wave 1 parallel run; no review artifact for this track exists yet |

Slice 2 (core proxy, already has a `incomplete_wip` review at
`20260712T-review-result-feat-458-s2.md` citing this exact gap) should not be
re-opened for merge until the two in-progress rows above land with their own
review evidence on disk, per the FEAT-471 rule ("review artifact on disk
before merge") already invoked in the FEAT-458 handoffs. This artifact
records the design half of the gate only; it does not fast-track the
mechanical half.

## What the security design (S3/S4) is bound to

These are not proposals — they are accepted constraints from ADR-013's
Decision 4 and Review decisions, carried into the FEAT-458 acceptance
criteria for slice 3 (S3-AC-2, S3-AC-3) and slice 4:

- **Structural header exclusion, not redaction.** The capture fork's input
  type must carry body-only fields — there is no headers field for the fork
  to reference at all. ADR-013 Decision 4 and Review decision 3 are explicit
  that this is enforced by the type boundary (and a regression test), not by
  filtering or redacting headers after they reach the fork. "The capture
  fork must never receive headers at all" (ADR-013 Decision 4).
- **Read-only tee, no parse-mutate-reserialize on the forward path.** The
  forward path is a single chunk-by-chunk pipe from upstream to client; the
  capture fork reads a tee of the same chunk stream on a code path that
  cannot write back into the forwarded stream (ADR-013 Decision 1
  "Tampering" row, Decision 3).
- **`capture_source: 'proxy'` as a second enum value** alongside the existing
  `'auto_capture'` (migration 024, already unconstrained `TEXT`, no schema
  change required) — makes proxy-sourced atoms distinguishable in doctor
  counts, purge scoping, and audit (ADR-013 Decision 1 "Repudiation" row,
  Consequences section).
- **Canary-header regression test** — a test asserting a canary header
  injected at the proxy never appears in any spool write (ADR-013 Review
  decision 3; FEAT-458 S3-AC-3).
- **Reuse of the existing spool and the FEAT-467 purge primitive** — no new
  trust boundary, no new deletion mechanism. `src/ingest/spool.ts` unchanged;
  `src/server/routes/capture-purge.ts` (FEAT-467, done on main, `'proxy'`
  scoping already proven in `tests/server/capture-purge.test.ts:92-107` and
  `tests/storage/memory-events.test.ts:608-613`) is reused as-is (ADR-013
  Consequences section).
- **Fail-open forwarding, fail-silent capture — never fail-closed on the
  user's request.** A capture-fork failure is logged and dropped; forwarding
  is never delayed, altered, or rejected because of it (ADR-013 Decision 2).
  Rejected alternative: fail-closed (block the request) — explicitly rejected
  because it would convert a memory-formation feature into a single point of
  failure for every agent using the proxy.

## Gate posture

Two separate gates apply to FEAT-458, and this artifact is careful to keep
them distinct because an earlier draft of DEC-014 conflated them and an
independent architecture review caught and forced the correction:

- **The build gate (ADR-013's own text).** ADR-013 itself gates *building*,
  not just deployment — in three places: its status line ("building remains
  gated on the Decision-6 rollout conditions being met", ADR-013:3-5), its
  Consequences section ("FEAT-458 remains blocked until ... Decision 6's four
  rollout-gate conditions are independently verified true", ADR-013:210-212),
  and its slice-decomposition table heading ("post-gates", ADR-013:165). Read
  literally, this blocks starting S2 core-proxy implementation, let alone S3,
  until the 14-day bake, the real scrub-evidence instance, and FEAT-463 are
  all independently verified true — which they are not as of 2026-07-12 (the
  S2 review already found this and returned `incomplete_wip` on exactly this
  basis).
- **DEC-014's override.** DEC-014 does not reinterpret ADR-013 as saying
  something it doesn't say. It is an **explicit operator override** of
  ADR-013's literal build gate, accepted on 2026-07-12 for a specific,
  stated reason: astramem-local is a single-user local daemon, so the
  disclosure risk ADR-013 is protecting against lands only on the operator's
  own box (no customers, no third parties, no shared infrastructure) — and
  the one protection that does extend beyond that box, npm consumers of the
  published package never receiving surprise traffic capture, is preserved
  independently by the hard rule that the capture flag ships **default-OFF
  in every released artifact**. DEC-014 states this plainly: "this is an
  explicit operator override of ADR-013's strict reading, not an
  interpretation of it."

Stated plainly, so it cannot be misread a second time:

- **Development of S1–S4 proceeds** under the DEC-014 override, in parallel
  with the (currently-reset) bake clock.
- **Production enablement remains blocked.** Turning proxy capture ON in the
  operator's production daemon config is forbidden until the bake gate is
  honestly satisfied (restarted, per DEC-014, once capture is observed
  actually working under the FEAT-455 fix) and an explicit operator call is
  made. This is not a formality — DEC-014's Consequences section records that
  the original bake accrued **zero** scrub evidence (auto-capture was ON in
  prod since 2026-07-10 but captured 0 memories, because the capture-at-close
  fix was merged but never released) and must restart once the plugin
  releases land and capture is confirmed working.
- **The capture flag ships default-OFF in every released artifact**, without
  exception, in every slice from S3 onward. This rule is not contingent on
  the bake gate and is not something a future edit may relax without a new
  decision record.

## Hard gate: the S3 interim review checkpoint

ADR-013 Review decision 5 requires a **dedicated interim review checkpoint**
for slice 3 (the capture fork), in addition to the standard reviewer gate,
before slice 4 may open:

> "Slice 2 interim checkpoint: yes. The capture-fork slice gets its own
> dedicated review checkpoint (byte-transparency + non-mutation evidence)
> before slice 3 opens, in addition to the standard reviewer gate."

(ADR-013 numbers this "slice 2" in its own internal slice table because
ADR-013 was written before FEAT-458's four-slice S1–S4 numbering was
finalized; in FEAT-458's numbering this is the S3→S4 boundary, and FEAT-458
codifies it explicitly as S3-AC-6.) This checkpoint must present
byte-transparency and non-mutation evidence for the capture fork specifically
— not just passing tests — and must be recorded as its own artifact on disk.
It is a hard gate: S4 (hardening) does not open without it, independent of
and in addition to the normal `crew:reviewer` pass on the S3 diff.

## Remaining operator-call open questions

These are open as of this writing and are not resolved by this artifact:

1. **Restarted bake length.** DEC-014 records that the bake will be
   "restarted and shortened" once capture is confirmed actually working
   (after astramem-plugin 0.6.2 and runner-plugin 0.72.0 land), but the
   shortened length is an explicit operator call, not derived — the original
   14 days was itself "accepted as drafted," not derived (ADR-013's own
   open-questions section asked whether 14 was the right number and the
   operator accepted it without deriving it).
2. **ADR-013 open question 2** (loopback-only bind, no shared secret, in v1)
   was answered by Review decision 2 as accepted for v1, with an opt-in
   shared-secret mode left as a possible future enhancement, not a v1
   requirement — this remains a standing option, not a commitment.
3. **Whether multiple independent operators or a longer bake window** should
   apply given the proxy's higher blast radius (ADR-013 open question 1) was
   answered for the *original* 14-day bake by Review decision 1 ("accepted as
   drafted"); it has not been re-asked for the *restarted* bake, and DEC-014
   defers that specifically to the operator's call.

## Sources cited

- `docs/adr/ADR-013-llm-proxy-auto-capture.md` (STRIDE table; Decision 2;
  Decision 4; Decision 6; Review decisions 1–5)
- `.claude/artifacts/loop/decisions/DEC-014.md` (corrected rationale)
- `.claude/artifacts/crew/handoffs/20260712T220000Z-feat458-proxy-parallel-session-plan.md`
- `.claude/artifacts/crew/handoffs/20260712T224500Z-feat458-parallel-execution-plan.md`
- `.claude/artifacts/crew/handoffs/20260712T230000Z-feat458-waves-orchestrator-handoff.md`
- `.claude/artifacts/loop/backlog/triaged/FEAT-458.md` (S1–S4 acceptance
  criteria)
- `.claude/artifacts/loop/backlog/done/FEAT-467.md`
- `.claude/artifacts/crew/reviews/20260712T-review-result-feat-458-s2.md`
- `.claude/artifacts/crew/deployments/20260710T172500Z-feat458-bake-clock-start.md`
- Repo state observed directly on 2026-07-12 (`git branch -a`, `git worktree
  list`, `ls scripts/eval/proxy-bench`) for the in-progress-work table above
