---
feature: FEAT-458
slice: S2
branch: feat/feat-458-s2-proxy-core
worktree: C:\work\mega\astramemory-local-worktrees\w458s2
reviewer: crew:reviewer (independent)
date: 2026-07-12
status: completed
decision: incomplete_wip
self_approval: false
---

# Review: FEAT-458 S2 — LLM proxy core

## Summary

The diff itself (10 files, 720 insertions: `src/proxy/server.ts`,
`src/cli/proxy.ts`, config plumbing, 5 test files) is well-built —
byte-transparent forward path is correctly implemented on raw
`node:http`/`node:https` (deliberately not Fastify, with the reasoning
documented inline), loopback-bind refusal is enforced before any bind
attempt, hop-by-hop headers are stripped correctly per RFC 7230 §6.1,
SSE is relayed via `.pipe()` with no buffering, and there is a structural
import-graph test proving zero capture code paths. Build is clean; ran
`bun run build` + `vitest run tests/proxy tests/config/proxy-downgrade.test.ts
tests/config/writer.test.ts` myself in the w458s2 worktree: **40/40 pass**
(matches the reported 133/133 across the fuller proxy+config suite).

Despite that code quality, this is **not mergeable as-is** — it is genuinely
incomplete relative both to slice 2's own acceptance criteria and, more
importantly, to FEAT-458's own hard gates for even starting implementation.

## Finding 1 (BLOCKING): the runtime bake gate this FEAT itself requires has not cleared

FEAT-458's own triage notes are explicit: `autonomous_safe: false` is forced
three independent ways, and building is gated on a **RUNTIME condition** —
"FEAT-455 hook-tap 14-day production bake + ≥1 real scrub-evidence instance
+ FEAT-463 shipped" — not merely a design-review-completeness gate.
`.claude/artifacts/crew/deployments/20260710T172500Z-feat458-bake-clock-start.md`
records: bake started **2026-07-10T17:25Z**, gate satisfied **2026-07-24T17:25Z**
(14 days). Today is 2026-07-12 — the bake is 2 days in, **12 days short**.

The S2 WIP commit `7e96deb` is timestamped 2026-07-10 12:39:29 -0500
(= 17:39:29Z) — **14 minutes after** the bake clock started. Core proxy
implementation work began essentially the moment the gate opened rather than
after it cleared. This is a process violation the ADR/FEAT itself calls
out as a hard prerequisite, not a nice-to-have.

## Finding 2 (BLOCKING): slice 1 (design gate) was never actually closed

`FEAT-458.md` frontmatter still reads `status: triaged`, `slices: []` — no
slice has been opened/closed through the loop ceremony for this FEAT at all.
Concretely, S1's own acceptance criteria are unmet:

- **S1-AC-3** (bench harness skeleton under `scripts/eval/proxy-bench/`,
  methodology pinned ahead of implementation): **does not exist**. Searched
  the full tree (`git ls-tree -r`) — only `scripts/eval/extraction-bench/`
  and `scripts/perf/bench.mts` exist; no `proxy-bench` anywhere.
- **S1-AC-4** (a design-gate artifact recording S1 completion before S2 may
  open): no such artifact exists under `.claude/artifacts/crew/` or
  `.claude/artifacts/loop/` for FEAT-458 — only the PM triage note, ADR-013,
  and the bake-clock deployment note.
- **S1-AC-2** (config surface: default-off + dedicated CLI subcommand +
  **doctor WARN row** + disable→purge parity) is only half-delivered. Default
  OFF and the CLI subcommand are done. The doctor WARN row is explicitly
  pushed to S4 by the branch's own code comment in `src/config/config.ts`
  ("so `doctor` has something to read (FEAT-458 S4)") — but S1-AC-2 asks for
  it now, not in S4 (S4-AC-3 is a *different*, capture-specific WARN row).
  Disable→purge parity with the FEAT-455 flow is absent entirely.

Because S1 never produced a bench harness, **S2-AC-4 cannot possibly be
satisfied** — there is no latency evidence anywhere in this diff or in any
artifact (added p50 vs. direct upstream call, <10ms target). This is the
one S2 AC that is not just unmet but structurally unmeetable without S1
work that was skipped.

## S2 acceptance criteria coverage

| AC | Requirement | Status |
|---|---|---|
| AC-1 | Byte-transparent forwarding incl. SSE | **Met** — `tests/proxy/byte-transparency.test.ts` covers non-streaming, SSE (chunk-arrival timing asserted, not just final byte equality), headers |
| AC-2 | Non-loopback bind refused with clear error | **Met** — checked pre-bind in both `src/proxy/server.ts` (`assertLoopbackBind`) and `src/cli/proxy.ts`; `tests/proxy/loopback-refusal.test.ts` spawns the real built CLI and pins the exact stderr string |
| AC-3 | Upstream error relayed unchanged | **Met** — status/body/headers test in byte-transparency.test.ts |
| AC-4 | p50 added latency <10ms vs. direct call, evidence captured | **Not met** — no bench harness exists (blocked on missing S1-AC-3), no evidence produced |
| AC-5 | Zero capture code paths in the diff | **Met** — `tests/proxy/zero-capture-imports.test.ts` walks the real transitive import graph from both entry points and asserts no `src/capture`/`src/ingest`/`src/distill` import; manual read of `server.ts`/`proxy.ts` confirms no capture-adjacent logic |

**4 of 5 S2 ACs met on the merits.** AC-4 is unmet and cannot be closed
without first doing the S1 work that was skipped.

## Other notes (non-blocking, for whenever this resumes)

- `Authorization` and all other non-hop-by-hop headers forward unfiltered by
  design (ADR-013 Decision 4 requires provider keys reach upstream
  unchanged) — correct per the ADR, flagging only because it's the one
  place a reviewer should double-check intent vs. accident; it's clearly
  intent here (explicit comment + a canary-header assertion in the byte-
  transparency test proves headers aren't being logged or dropped).
- No per-request timeout on the upstream call — an upstream that accepts
  the connection but never responds will hang that request indefinitely.
  Likely intentionally deferred: S4's own AC-1 is a "failure-mode test
  matrix" (upstream down, spool full, daemon down, capture throws mid-SSE)
  that reads as the intended home for this. Flagging so it isn't lost, not
  as an S2 blocker.
- `SIGTERM`/`SIGINT` handlers are registered per `proxyCommand()` call with
  no corresponding removal — fine for the CLI's single-process lifetime,
  worth a second look if `proxyCommand` is ever called more than once
  in-process (e.g. from a test harness that starts/stops the CLI function
  directly rather than spawning it).

## Decision

**incomplete_wip.** Not a request for a fix-up pass on the diff — the code
in the diff is solid and 4/5 S2 ACs pass cleanly. The reason this can't ship
is upstream of the diff: FEAT-458's own hard gates (14-day production bake,
still 12 days out as of 2026-07-12; and slice 1's design-gate deliverables,
which were never produced) were not satisfied before this implementation
work started. Recommend: park this branch as-is (it's good work, don't
discard it), and reopen S1 properly — build the `scripts/eval/proxy-bench/`
harness skeleton, land the doctor WARN row and disable→purge parity, write
the S1 design-gate artifact — then let the bake clock finish (2026-07-24)
before resuming S2 for real, at which point this diff's core logic can very
likely be reused close to as-is with the bench evidence (AC-4) added.
