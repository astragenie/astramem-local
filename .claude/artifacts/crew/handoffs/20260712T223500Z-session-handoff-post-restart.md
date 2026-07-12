---
type: handoff
created: 2026-07-12T22:35:00Z
author: lead (session 73550e33)
objective: Resume astramem-local work after a Claude Code restart — stable promotion, LoCoMo, revenue door, proxy
status: ready-for-pickup
---

# Session handoff — read this first after restarting

**You are the session that picks up after a restart.** The restart itself was
required (see §1). Everything below is verified against the live repo/daemon on
2026-07-12, not inferred from backlog files — the backlog was badly stale and is
what sent the previous roadmap chasing phantom work.

---

## 1. Why the restart happened — VERIFY IT WORKED

The capture-at-close fix was published today (astramem-plugin **v0.6.2**,
runner-plugin **v0.72.0**, marketplace updated). Running Claude Code sessions
execute plugin hooks from memory, so the fix could not take effect until a restart.

**First thing to do — confirm capture is now alive:**

```bash
node dist/cli/index.js doctor 2>&1 | grep -i "auto-capture"
```

- **Was (broken):** `✗ Auto-capture: auto-capture is ON but 0 memories have ever
  been auto-captured, despite 12452 active memories already in the store`
- **Want:** the count climbs above 0 after a session/subagent close cycle.

If it is STILL 0 after real session activity post-restart, capture is still broken
and the FEAT-458 bake gate is still fictional — investigate before anything else.
Check `%APPDATA%\Astramem\ingest.log` for `transcript file not found` (the old
failure signature).

**This gates the proxy timeline.** The 14-day bake was accruing nothing because
capture was dead. Per operator decision: once capture is *observed* working, the
bake **restarts and is shortened** (the original 14 days was "accepted as drafted,"
never derived).

---

## 2. Open PRs — all gated, none merged

| PR | What | Gate |
|---|---|---|
| [#158](https://github.com/astragenie/astramem-local/pull/158) | Stable-promotion groundwork (17 commits) | SLICE-425: review PASS + validation PASS |
| [#159](https://github.com/astragenie/astramem-local/pull/159) | FEAT-475 flake fix (partial, deliberately) | Review `approved_with_notes` |
| [#160](https://github.com/astragenie/astramem-local/pull/160) | Doctor canaries + feedback e2e | Review `approved_with_notes`, findings **fixed not filed** |

Shipped outward (operator-approved, byte-verified on disk): astramem-plugin 0.6.2,
runner-plugin 0.72.0, astra-marketplace registry.

---

## 3. THE finding — astramem's dominant failure mode

**Three headline features were built to a high standard, merged, unit-tested green,
and never actually invoked.** The engineering is not the weak link. The last mile is.

1. **Auto-capture** — fix merged in both plugins, version bumped, **never tagged**.
   0 memories in 2 days of a "production bake." *Fixed today.*
   - Trap worth knowing: version `0.6.1` was **poisoned** — the bump landed 4 days
     *before* the fix merged, so two different codebases both called themselves
     0.6.1. Re-tagging v0.6.1 would have changed nothing. Cache invalidation
     requires a **new version number**.
2. **Usefulness feedback loop** — works perfectly when called. Called **zero times**
   across 12,452 memories / 177 served atoms. Root cause was almost comic:
   `submit_feedback`'s own MCP tool description said it *"does not affect ranking."*
   It does. Agents read that and correctly concluded it was pointless. *Fixed in #160.*
3. **LoCoMo harness** — complete, reviewed, six passing test suites, **never run.**
   The dataset had never even been downloaded. *Prepped today; see §4.*

**Every one passed CI.** Unit tests verify components; these all died at the *wires*.

**Defense now in the repo (PR #160):** `doctor` canaries that detect the *class* —
auto-capture ON but 0 captured; ≥20 atoms served but 0 ever marked used. They caught
the auto-capture bug on their first production run.

**Habit to keep:** when told a feature works, don't verify the code is correct —
verify something **calls it**, in production. A frozen default (every usefulness
score exactly 0.5) is the signature of a loop that has never run.

---

## 4. LoCoMo — ready, needs a HUMAN to press go

Dataset downloaded and verified (`.eval-data/locomo/locomo10.json`, 2.8MB, sha256
`79fa87e9…`, 10 conversations, 1,986 QA pairs, **272** content-bearing sessions —
note: NOT the 287 everyone cites). Methodology doc committed at
`docs/eval/locomo-methodology.md`.

**Run from a plain terminal a human opened — NOT an agent shell.** A sandboxed agent
shell silently reaped a spawned daemon and destroyed a 40-minute eval run on
2026-07-08.

```powershell
cd C:\work\mega\astramemory-local
bun install && bun run build
bun scripts/eval/locomo/run.mts --distill-timeout-ms 28800000 --detach
```

~3.8h, detached. **Do not drop the `--distill-timeout-ms` flag** — the default is
15 minutes and would time out every conversation.

Then: `bun scripts/eval/locomo/judge.mts --hyp <rundir>/hypotheses.jsonl --ref <rundir>/sample.json`

Caveats that must travel with any published number: our answerer emits
natural-language sentences, not the short extracted spans the original baselines
produce, so token-F1 reads **harsher** for us for reasons unrelated to retrieval
quality. Also: the code reads `AZURE_OPENAI_KEY`, not `AZURE_OPENAI_API_KEY` as the
docs claim (az-cli fallback currently covers it).

**Why it matters:** there is currently **no benchmark number for any benchmark** for
this project. LongMemEval's own README says "do not cite a LongMemEval accuracy
number for astramemory-local — none exists." You cannot credibly promote "stable"
against Zep's cited 63.8% with nothing.

---

## 5. Recommended priority (my strong opinion, operator has not committed to all of it)

1. **Verify capture is alive** post-restart (§1). Free, gates everything.
2. **Run LoCoMo** (§4). ~4h wall-clock, mostly unattended. Cheapest credibility.
3. **Build the revenue door — half a day. THIS IS THE HIGHEST-ROI ITEM ON THE BOARD.**
   - **1,051 npm installs last week** (verified live). **Not one of those users is
     ever told the cloud exists.**
   - Stripe is LIVE (real keys, working fail-closed webhook, Free/$19/$79/Enterprise
     ladder, Clerk auth, instrumented PostHog funnel). `astramem-local pair` works;
     the old wrong-redeem-URL bug is already fixed.
   - But `pair` appears on **zero** user-facing surfaces: not the README command
     table, not the `init` wizard, not the quickstart. The only cross-repo doc,
     `docs/migration-from-saas.md`, runs the *opposite* direction — a churn doc.
   - Local storage has **no cap** — nothing a local user experiences ever gives them
     a reason to pay.
   - Fix: add `pair` to the README table + one `init` wizard epilogue line + a short
     "Sync & Teams" doc. **Verify first** whether the dashboard's copy-paste snippet
     (`PairingPanel.tsx` says `memory-connect …`) conflicts with the daemon's
     `astramem-local pair` — they may be two different flows.
   - Operator deferred this ("not yet — proxy first"). **I would push back on that.**
     Two weeks of proxy work does not add a door.
4. **Zero telemetry.** Grepped the whole daemon: no analytics, no phone-home. We have
   NO idea how many of the 1,051 complete `init` or return. Recommend an opt-in,
   disclosed, **default-OFF** ping (1–2 days) — respects the local-first stance that
   *is* the moat.
5. **Wire the feedback loop.** Small. Makes "self-learning" a true claim instead of a
   deleted one. **Take the signal from work that already happens** — slice closes
   green → mark recalled memories used — NOT from asking agents to call
   `submit_feedback`. Nobody does chores; that's exactly why it sat at zero.
6. **Ship stable on what's TRUE** (~1 week): entity-tagged memory with point-in-time
   filtering, usefulness-ranked profiles, encrypted-at-rest by default, local-first,
   plus a real LoCoMo number.

---

## 6. Language discipline for the promotion — these words are FALSE

Verified against source. Using them in front of a skeptical engineer will burn trust:

- ❌ **"self-learning"** → ✅ *"usefulness-ranked"*. Profiles are live-computed SQL
  rollups. Nothing learns; a Laplace counter re-sorts a fixed set.
- ❌ **"knowledge graph"** → ✅ *"entity-tagged memory with point-in-time filtering"*.
  Schema has `entities` + `memory_entities` (a link table). **There is no
  entity-to-entity relations table.** Graphiti/Zep are graphs; we are one join short
  of where they start.
- ❌ **"bitemporal"** → ✅ *"valid-time"*. Single axis only; no transaction-time.
  (Graphiti is also valid-time-only — the old gap analysis overclaimed BOTH systems
  and had us chasing a gap that doesn't exist. Corrected in #158.)
- ❌ **"accurate entity extraction"** — entity extraction accuracy is **completely
  unmeasured**. `extraction-bench/lib/judge.ts` has zero entity-scoring logic. The
  cited 67% F1 is for atom type+text only.

Good news: the user-facing docs never actually claimed these. Keep it that way.

---

## 7. Proxy (FEAT-458) — running in a SEPARATE parallel session

Full plan: `.claude/artifacts/crew/handoffs/20260712T220000Z-feat458-proxy-parallel-session-plan.md`

**It is NOT nearly done.** What exists is a byte-transparent HTTP relay that captures
nothing — `tests/proxy/zero-capture-imports.test.ts` structurally *proves* it. **S3,
the capture fork (the actual feature), has zero lines written.** ~6–9 dev-days, and
S3 is the only slice ADR-013 rates high-risk.

**DEC-014 — read it.** The bake gate was overridden to allow *development* (not
production enablement) during the bake. Be honest about what that is: ADR-013's text
gates *building*, in three places. **This is an operator override of a security gate,
not an interpretation of it.** Justified because "production" here is a single-user
local daemon on the operator's own 127.0.0.1, and the one protection that reaches
real users — *default-OFF capture in every released artifact* — is preserved as hard.
An earlier version of DEC-014 (written by me) claimed ADR-013 only gated deployment.
**That was wrong** and was corrected.

---

## 8. Backlog reality check — do NOT trust the old roadmap

The post-v0.15.0 roadmap handoff planned against stale state and was largely fiction:

- **FEAT-453** was scheduled as 1–2 weeks of Wave C. It had **already shipped in
  v0.12.0**. Only the cross-repo cloud mirror remains.
- **FEAT-474** was 9 installer patterns; **4 were already done or N/A**.
- **The bake gate** was going to open 2026-07-24. It was never going to open.
- **The competitor gap analysis** said we were behind Graphiti on bitemporal. We're
  at parity.

Remaining real backlog: FEAT-464 (TS7 bump — **must run SOLO** on the toolchain
surface, see DEC-013), FEAT-458 (proxy), FEAT-446/460 (sibling repos, out of scope).

---

## 9. Landmines

- **NEVER kill processes by image name** (`taskkill /F /IM node.exe`,
  `Stop-Process -Name node`, `pkill node`). This box runs the PRODUCTION daemon,
  Ollama, sibling agents, and possibly a multi-hour eval. It already destroyed a
  40-minute eval run once. Kill only PIDs you spawned.
- **Never `git stash`** — the stash stack is repo-global across worktrees.
- **A `v*` tag push AUTO-PUBLISHES** to npm via CI. Never run a manual `npm publish`
  after — it collides.
- **Daemon runs on port 7777**, not 7070.
- `dev.stable: true` is set — local commits without asking are fine. Publish, tag
  pushes, force-pushes, and prod promotion still require the operator.
- **AC parser gotcha:** the slice-store only recognizes AC bullets starting with
  `Given` or `AC-<n>` — *with a hyphen*. A hyphenless `AC1` is silently invisible.
  (Fixed in runner-plugin 0.72.0.)

---

## 10. Suggested first actions

1. `node dist/cli/index.js doctor` → confirm auto-capture count > 0. (§1)
2. Kick off LoCoMo in a human terminal. (§4)
3. Ask the operator to reconsider the revenue door (§5.3) — half a day, and it is the
   only item on the board that touches revenue.
