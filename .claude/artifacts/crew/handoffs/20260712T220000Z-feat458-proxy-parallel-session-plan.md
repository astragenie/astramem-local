---
type: handoff
created: 2026-07-12T22:00:00Z
author: lead (session 73550e33)
objective: Implement FEAT-458 LLM proxy auto-capture (S1 backfill → S2 finish → S3 capture fork → S4 hardening)
status: ready-for-pickup
owner: a SEPARATE parallel session — NOT the session that wrote this
---

# FEAT-458 — proxy implementation plan (parallel session)

**Read this whole file before touching anything.** It is written to be picked up
cold by a session with no context.

---

## 0. The one-paragraph truth

The proxy is **not** partly done. What exists is a byte-transparent HTTP relay
that **captures nothing** — there is a test (`tests/proxy/zero-capture-imports.test.ts`)
that structurally *proves* no capture code exists. The relay is good code and
reviewed well. But the feature — capturing LLM traffic into memory — has **zero
lines written**. You are building the actual feature, not finishing someone's.

Effort: **6–9 dev-days.** S3 is the risky one and may overrun.

---

## 1. Collision boundaries — READ FIRST

Another session is running concurrently on the stable-promotion track. Stay out
of its way:

| Path | Status |
|---|---|
| `C:\work\mega\astramemory-local-worktrees\w458s2` | **YOURS.** Branch `feat/feat-458-s2-proxy-core`. Work here. |
| `C:\work\mega\astramemory-local` (main checkout) | **NOT yours.** The other session commits here. Read freely; do not edit. |
| `...-worktrees\w474`, `...-worktrees\w475` | NOT yours. Active builders. |
| `C:\work\mega\runner-plugin`, `C:\work\mega\astramemory-plugin`, `C:\work\mega\astra-marketplace` | NOT yours. A release is in flight. |
| `scripts/eval/locomo/`, `.eval-data/` | NOT yours. A ~4h benchmark run may be executing. **Do not spawn heavy Ollama load** — you'll contend for GPU with it. |

Your branch is 1 commit behind main — rebase/merge main in early, do not
discard the branch (its core is reviewed-good).

---

## 2. Hard constraints — violating any of these is a failed slice

- **NEVER kill processes by image name** (`taskkill /F /IM node.exe`,
  `Stop-Process -Name node`, `pkill node`). This box runs the PRODUCTION daemon,
  Ollama, sibling agents, and possibly a multi-hour eval. An image-name kill
  murders all of them (it already destroyed a 40-minute eval run once). Kill only
  PIDs you spawned.
- **Never `git stash`** — the stash stack is repo-global across worktrees; a pop
  can eat a sibling session's work.
- **Never enable proxy capture in the production daemon config.** See DEC-014:
  you may DEVELOP capture; you may not TURN IT ON in prod. The capture flag must
  be default-OFF in everything you ship.
- **Do not push. Do not merge to main. Do not tag.** Local commits on your branch.
- Byte-transparency is an **architectural invariant, not a promise** — see §5.

---

## 3. The gate situation (resolved — do not re-litigate)

FEAT-458's `triage_notes` claim the bake gate blocks *building*. ADR-013 — the
actual security authority — says it blocks capture *"going live in production."*
**DEC-014 resolves this: the gate blocks production enablement, not development.**
You are cleared to implement S1–S4 now.

Separately, and importantly: **the bake was accruing nothing.** Auto-capture has
been ON in prod since 2026-07-10 and captured **0 memories** — the capture-at-close
fix was merged but never released, so every installed hook ran the old broken path.
Plugin releases (astramem-plugin 0.6.2, runner-plugin 0.72.0) are being cut now to
fix that. The bake will restart, shortened, once capture is *observed* working.

None of this blocks you. It only means: do not assume the gate will be green on
2026-07-24, and do not enable anything in prod.

---

## 4. Slices, in order

### S1 — design-gate backfill (~1–2 days, low risk)
S1's deliverables were **skipped**, not completed. They block S2's evidence.

- **S1-AC-3 — bench harness.** Create `scripts/eval/proxy-bench/`. Does not exist
  today. Without it, S2-AC-4 (p50 <10ms) is *structurally unmeasurable* — this is
  the concrete reason the S2 review said `incomplete_wip`. Build this FIRST; it
  gates S2's close. Model it on the existing harnesses in `scripts/eval/shared/`.
- **S1-AC-2 — doctor WARN row** for proxy state. Note `src/config/config.ts:344`
  defers a *different*, capture-specific WARN to S4 — that is not this.
- **S1-AC-4 — design-gate closure artifact** under `.claude/artifacts/crew/`.
- **disable→purge parity.** The primitive already exists and is generic:
  `src/server/routes/capture-purge.ts` (FEAT-467, on main, zero source-specific
  branching by design). Wire the proxy's future disable flow to it — near-trivial.
  Do NOT build a parallel purge mechanism.

### S2 — finish the core (~1–2 days)
Branch `feat/feat-458-s2-proxy-core` has `src/proxy/server.ts` + `src/cli/proxy.ts`
+ 3 test files (556 lines). Reviewer independently re-ran the suite: **40/40 pass**,
code quality genuinely good. **4 of 5 ACs pass on the merits** (AC-1 byte
transparency, AC-2 pre-bind loopback refusal, AC-3, AC-5).

- Rebase onto main (1 commit behind — trivial).
- **S2-AC-4**: produce p50 <10ms latency evidence using the S1 bench harness.
  This is the only failing AC and it fails for lack of a measuring tool, not for
  lack of speed.
- Fresh full review (the existing review predates your changes), then merge.

### S3 — the capture fork (~2–3 days) ⚠️ THE HIGH-RISK SLICE
ADR-013 rates this the **only "high" risk slice in the FEAT.** Nobody has built a
provably non-mutating live tap in this codebase. Budget for overrun.

Requirements, from ADR-013's STRIDE table — these are not negotiable:
- **The fork must NEVER receive headers.** Not "redact the Authorization value" —
  **structurally exclude headers** from what the capture path can see. The proxy
  sees the upstream provider's own API key on every request; the fork consumes
  **body only**, which is the sole capture requirement and contains no credential
  by construction.
- **Read-only tee, not a rewrite.** The forward path streams upstream bytes to the
  client via a single pipe with **no parse-mutate-reserialize step**. Capture
  observes a *copy* on a code path that cannot write back into the forwarded stream.
- **`capture_source: 'proxy'`** — a second value alongside the existing
  `'auto_capture'` (migration 024). Makes proxy atoms distinguishable in doctor
  counts, purge scoping, and audit.
- **Canary-header regression test**: prove headers never reach the spool.
- Reuses the existing durable spool (`src/ingest/spool.ts`) — no new trust boundary.
- **A dedicated interim review checkpoint** (byte-transparency + non-mutation
  evidence) is REQUIRED before S4 opens — ADR-013 Review decision 5. This is in
  addition to the normal reviewer gate.

### S4 — hardening (~2 days)
- Failure-mode matrix. **Fail-open forwarding, fail-silent capture** (ADR-013
  Decision 2): a hung proxy hangs *every agent turn using it*. "Proxy down ≠ agent
  down" is the FEAT's own framing.
- Latency bench again *with capture live* — still p50 <10ms.
- Doctor WARN row for capture-enabled state.
- Live disable→purge e2e against real `capture_source: 'proxy'` records.

---

## 5. The thing that will bite you

The proxy is the **highest-density information-disclosure surface in the entire
system** — higher than hook-tap, which never sees third-party credentials. It sees
full system prompts, every turn, and the upstream provider's API key.

Stage-0 redaction is the enforcement point for body content, and ADR-013
explicitly **refuses** FEAT-455's "ship now, redaction gaps are a tracked
follow-up" posture, because the proxy's volume and latency-adjacency raise the
cost of a miss.

If you find yourself writing code where the capture path *could* see a header,
stop and restructure. The safety property is architectural, not a runtime check.

---

## 6. Ceremony

This repo runs the crew/loop harness. Per slice:
1. `/runner:start --id SLICE-NN` (rotates `currentRun`; do not skip)
2. Builder implements
3. `crew:reviewer` → **review artifact must be written to disk BEFORE merge** —
   a conversational "PASS" does not clear the gate (this rule exists because
   FEAT-471 was merged on a review that hadn't happened yet)
4. `crew:verifier` if behavior changed
5. `/runner:close --id SLICE-NN`

`dev.stable: true` is set — local commits without asking are fine. Publishing,
tag pushes, force-pushes, and prod promotion are NOT unlocked and still need the
operator.

**AC authoring gotcha:** the slice-store AC parser only recognizes bullets
starting with `Given` or `AC-<n>` — **with a hyphen**. A hyphenless `AC1` is
silently invisible and the gate reports "no acceptance criteria" while pointing
you at the heading, which is fine. (Fixed in runner-plugin main; unfixed in the
cached plugin until 0.72.0 lands.)

---

## 7. Key files

| What | Where |
|---|---|
| The FEAT | `.claude/artifacts/loop/backlog/triaged/FEAT-458.md` |
| The security ADR — **read this** | `docs/adr/ADR-013-llm-proxy-auto-capture.md` |
| S2 review (`incomplete_wip`) | `.claude/artifacts/crew/reviews/20260712T-review-result-feat-458-s2.md` |
| Bake gate evidence | `.claude/artifacts/crew/deployments/20260710T172500Z-feat458-bake-clock-start.md` |
| Gate interpretation | `.claude/artifacts/loop/decisions/DEC-014.md` |
| Purge primitive (reuse) | `src/server/routes/capture-purge.ts` |
| Spool (reuse) | `src/ingest/spool.ts` |
| The relay you're extending | `src/proxy/server.ts` (worktree `w458s2`) |

---

## 8. Definition of done

Proxy capture works behind a **default-OFF** flag, with:
- p50 <10ms latency proven by the bench harness, capture live
- a passing canary test proving headers never reach the spool
- byte-transparency proven, not asserted
- disable→purge working end-to-end on real `capture_source: 'proxy'` records
- the S3 interim review checkpoint passed

**Production enablement is NOT part of done** — that waits on the (restarted,
shortened) bake gate and an explicit operator call.
