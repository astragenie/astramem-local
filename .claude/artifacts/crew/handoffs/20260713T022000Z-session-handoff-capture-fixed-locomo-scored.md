---
type: handoff
created: 2026-07-13T02:20:00Z
author: lead (session e08b8f83, Fable)
objective: Hand off to next Fable session — capture chain FIXED+shipped (v0.15.1), e2e smokes landed, LoCoMo scored with a decision pending
status: ready-for-pickup
---

# Session handoff — read this first

Successor to `20260712T223500Z-session-handoff-post-restart.md`. Everything below
verified live on 2026-07-12/13, not inferred.

## 1. Auto-capture: FIXED, SHIPPED, VERIFIED GREEN — do not re-investigate

The previous handoff's §1 gate is CLOSED. Doctor now says:
`✓ Auto-capture: 44 auto-captured memories currently stored`.

Two real root causes were found and both are fixed:

1. **Stale global CLI (the actual killer).** The v0.6.2 plugin hook prefers
   `astramem-local capture claude` (spool path). The global install was
   **0.3.4** (bun bin) — predates the `capture` subcommand → `unknown
   command` → silent fallthrough to the legacy path-read → "transcript file
   not found" → 0 captures, forever. Nothing verified the hook's runtime
   dependency. Global now 0.15.1. **Habit: when capture looks dead, check
   `astramem-local --version` on PATH before any daemon/plugin archaeology.**
2. **Canary measured a wire that doesn't exist.** Hook calls `capture claude`
   WITHOUT `--auto-capture`, so memories landed `capture_source=NULL` while
   the doctor canary counted only `'auto_capture'` — permanently red even
   with capture working. Fixed in commit **874c931**: plain CLI path stamps
   `'hook_close'`; canary counts both; `'auto_capture'` stays reserved for
   the future denser-sampling trigger; `disable --purge` still purges ONLY
   `'auto_capture'` rows (never hook_close).

Shipped as **v0.15.1** (tag → CI auto-publish, all checks green, npm serves
0.15.1). Daemon reinstalled: serving **0.15.1+d6801bc**. Global CLI 0.15.1.
Version-skew window (old daemon quarantining hook_close envelopes) never
opened — daemon was upgraded before the CLI started emitting the new value.

Sibling Claude Code sessions still running old in-memory hook code keep
producing "transcript file not found" log noise until each restarts —
expected, harmless, self-heals per session restart.

## 2. E2E smokes landed (same commit 874c931)

- `tests/e2e/auto-capture-close.e2e.test.ts` — real CLI → spool → fixture
  deleted mid-flight (race-fix proof) → drain → distill → all rows
  `hook_close` → doctor check ok.
- `tests/e2e/profile-learning.e2e.test.ts` — the behavioral claim, proven:
  mistake → superseded → search returns correction and hides the mistake →
  5× submit_feedback moves rank 4th→1st via the epsilon component →
  `agent_profile.corrections[]`/`top_lessons` → `user_profile.recurring_lessons`
  → invalidated memory vanishes everywhere. **Zero product bugs found.**

Review PASS + validation PASS artifacts exist (see commit message of 874c931).

## 3. PRs: ALL MERGED — prior handoff was stale

#158, #159, #160 auto-merged once CI+gates passed. Origin uses SQUASH merges;
local main had the same work as real commits, so syncing produced 2 expected
conflicts in doctor files — resolved (ours = superset). Local main pushed;
local and origin are in sync as of d6801bc.

## 4. LoCoMo: SCORED — number exists but means something specific

Full analysis: `.claude/artifacts/crew/runs/20260713T020500Z-locomo-first-scored-run.md`

- **Overall token-F1 0.2362** (category-avg 0.2179; adversarial 0.978,
  everything else 0.004–0.05; n=1986).
- **This measures extraction, not retrieval.** 1,857/1,986 answers were
  abstentions because the coding-tuned distill (prompt + durability gates)
  extracted only **136 memories from 272 conversational sessions**. Retrieval
  never saw the facts; the answerer correctly said "no information available".
  When a fact WAS stored, answers were short and often right.
- **DO NOT cite 0.2362 as retrieval quality** (memory saved:
  `locomo-score-measures-extraction`). Not comparable to Zep's 63.8%.
- Protocol deviation to fix on rerun: extraction ran daemon-default
  `qwen2.5:7b`; methodology doc assumes `qwen2.5-coder:7b`. Pin it.
- Ops: run infra worked end-to-end (272/272, resume-after-kill via FEAT-462
  ledger proved itself). Cost ~$2–3 Azure. Eval worktree kept:
  `C:\work\mega\astramemory-local-wt-locomo` (branch eval/locomo-20260712).

**OPEN DECISION (operator):** ①build conversational extraction profile +
rerun (~days, makes LoCoMo measure retrieval), ②publish as-is with analysis
and lean stable-promotion on ADR-005 floors + coding-agent strengths, or
③both. Operator was asleep when scored; not yet asked. **Explained in plain
terms 2026-07-13 ~02:30Z; operator's last words were "write hand off" —
pitch the decision again at session start.**

## 5. Still open from previous handoff (unchanged priorities)

- **Revenue door** (§5.3 of prior handoff) — 1,051 npm installs/week, `pair`
  on zero user-facing surfaces. Operator deferred ("proxy first"). Still the
  highest-ROI half-day on the board. Verify PairingPanel.tsx `memory-connect`
  vs daemon `astramem-local pair` mismatch first.
- **Feedback-loop producer** — mechanism proven perfect (see profile e2e),
  but live stats: 0 used / 274+ corrected. Wire the signal from work that
  already happens (green slice-close → mark recalled memories used), not
  agent chores. Small, makes "usefulness-ranked" real.
- **Telemetry** — still zero; opt-in default-OFF ping recommended (1–2 days).
- **FEAT-464** (TS7 bump — must run SOLO, DEC-013), **FEAT-458 proxy**
  (separate parallel session; it edits main checkout test files — e.g.
  `withProxyCaptureConfig` appeared in tests/cli/capture-claude.test.ts).

## 6. Landmines (carry forward, all still true)

- NEVER kill by image name (`taskkill /IM node.exe`, `Stop-Process -Name`) —
  prod daemon, Ollama, sibling agents, evals all on this box. The LoCoMo run
  WAS killed once by an unidentified external actor (~61 min in, silent,
  stderr empty) — resumed cleanly, cause never proven. If a detached eval
  dies silently again, suspect process-tree kills and check timing against
  your own TaskStop/cleanup actions.
- Never `git stash` (repo-global across worktrees).
- `v*` tag push AUTO-PUBLISHES via CI — never manual `npm publish` after.
  The runbook `docs/runbooks/release-publish.md` step 6 still says manual
  publish — STALE, worth a one-line doc fix.
- Daemon port 7777; `dev.stable: true` (local commits OK after review+
  validation PASS; pushes/tags/prod still operator-gated).
- Origin squash-merges PRs — after a PR merges, expect content-identical
  conflicts when syncing a local branch that carried the same commits;
  resolve with the superset side.
- Monitor scripts on Windows: `kill -0` false-positives in Git Bash; use
  `tasklist //FI "PID eq N"`, or better, file-read-only watchers (status
  json + log mtime) that spawn nothing.

## 7. Suggested first actions

1. Ask operator the LoCoMo decision (§4) — it gates the stable-promotion story.
2. Re-pitch the revenue door (§5) — still unbuilt, still half a day.
3. If proxy session finished S3, review its capture-fork work against
   ADR-013's default-OFF-in-released-artifacts hard line (DEC-014 context in
   prior handoff §7).
