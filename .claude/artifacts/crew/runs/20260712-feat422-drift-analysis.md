---
feature: FEAT-422
type: drift-analysis
status: partially-closed
date: 2026-07-12
---

# FEAT-422: Loop-doc drift — analysis, targeted patch, upstream routing

## Summary

FEAT-422 was filed 2026-07-04 against runner plugin v0.58.0, flagging two stale
references in `.claude/loop/rules.md`: `/runner:stop-check` (removed in v0.53) and
an "First Action" pointer to a permanently-empty `approved-slices.md`. By the time
this analysis ran (2026-07-12), the installed runner had moved to **v0.69.0**
(`installed_plugins.json`: installed 2026-06-17, last updated 2026-07-10T17:29:16Z)
— three version bumps past the FEAT's filing point, with the local `rules.md`
never regenerated in between.

## Method

Diffed all 8 cached template versions in
`~/.claude/plugins/cache/astra/runner/{0.54.0,0.58.0,0.61.0,0.63.0,0.64.0,0.65.0,0.66.0,0.69.0}/templates/loop-rules.md`
against each other and against the repo's installed `.claude/loop/rules.md`, and
the matching `templates/claude-md-hard-rules.md` against `CLAUDE.md`'s
`<!-- runner:start -->...<!-- runner:end -->` block. Also traced `approved-slices.md`
usage through the plugin's own source (`src/scripts/lib/loop-installer.mts`,
`.claude/loop/authoring.md`) and confirmed the `/runner:stop-check` command file is
genuinely absent from `commands/` in 0.69.0.

## Findings, classified

### (a) Stale local install — patched this session, upstream already fixed it

Between 0.58.0 and 0.69.0 the template changed in exactly one place, applied
identically in three spots per file (six total across `rules.md` +
`CLAUDE.md`): it stopped instructing dispatch to `crew:builder`, because **no
agent by that literal name exists** in this repo's roster (only
`crew:fullstack-dev` / `crew:backend-dev` / `crew:frontend-dev` / generic
`claude` do — confirmed against the live agent list). This was a real
correctness bug, not cosmetic: both `.claude/loop/rules.md` and `CLAUDE.md:145`
were telling the autonomous loop to dispatch a nonexistent agent.

**Applied this session** (targeted patch, no regen, HITL-approved):
- `.claude/loop/rules.md` — 3 sites: Slice Start Ceremony step 4, the Dispatch
  Discipline table row, and the "Never use `caveman:*`" line.
- `CLAUDE.md` — 1 site: the "Dispatch discipline" bullet in the HARD RULES
  summary block (line 145).

All four edits are word-for-word the upstream 0.69.0 template wording. `git
diff` confirms exactly these four hunks changed, nothing else. Not committed —
left for the lead/human to review and commit.

### (b) Upstream template bugs — routed upstream, not fixed locally

Diffing all 8 cached versions against each other shows **nothing else changed
in 11 version bumps** besides the crew:builder fix above. Both of FEAT-422's
original findings are still present in the *current* (0.69.0) template, so
regenerating locally would not have fixed them anyway:

1. **`stop-check` wording ambiguity.** The `/runner:stop-check` slash command
   is genuinely gone (no `commands/stop-check.md` in 0.69.0; matches the FEAT's
   own live-check output: "removed in v0.53. Use internal-only (runner:auto)
   instead."). The rules.md line in the auto-mode section ("`stop-check` still
   reports `iterationCount`/... in `snapshot`") refers to an internal
   telemetry function of the same name, still real and still invoked by
   `/runner:auto` — not literally an instruction to run a dead command — but
   the phrasing is ambiguous enough to send a fresh reader hunting for a
   command that doesn't exist. Unchanged across all 11 cached versions.
2. **`approved-slices.md` "First Action" pointer.** Traced through the
   plugin's own source: this is not vestigial in the template's worldview —
   it's the ledger for a manual slice-authoring flow
   (`slices/pending/` → review → `approved-slices.md`) that coexists with, but
   is bypassed by, the newer FEAT-based flow (`/runner:slice from-feature`)
   this repo actually uses. The template never branches on which flow a repo
   has adopted, so a FEAT-only repo's `approved-slices.md` stays permanently
   at its placeholder text. Confirmed still true here:
   `.claude/artifacts/loop/ai-loop/backlog/approved-slices.md` still reads "No
   approved slices yet" after 6+ completed slices. Unchanged across all 11
   cached versions.

**Disposition (HITL-delegated call, recorded here for closure evidence):
RETIRE the `approved-slices.md` step from "First Action."** This repo's own
`rules.md` already documents the real flow in its Cross-Slice Continuation
section (scan specs → pending → triaged → promote highest-priority feature);
"First Action" pointing at a dead ledger is an internal self-contradiction
inherited unchanged from the template. Wiring `slice from-feature` to append
to `approved-slices.md` instead was considered and rejected — it would add
ceremony overhead for a ledger this repo's flow has no other reader for.

**This is not a local fix** — the wording lives in the upstream template, and
both drift items are confirmed unchanged across every cached version. Filing
against `astra/runner` (not this repo) is the correct next step:
- Reword the auto-mode section's `stop-check` line to avoid naming a removed
  command in the same breath as a still-live internal check (e.g., "the
  internal stop-condition check, invoked via `/runner:auto`, not a standalone
  command, still reports...").
- Add a FEAT-based-flow variant of "First Action" (or drop the
  `approved-slices.md` step entirely) for repos where `/runner:slice
  from-feature` is the only slice-creation path — this repo's own community
  should push for RETIRE as the resolution, per the disposition above.

### (c) Local intentional additions — confirmed protected, untouched

Three paragraphs exist in this repo's `.claude/loop/rules.md` under "Worktree
Parallelism" that appear in **no** cached template version (0.54.0 through
0.69.0):
- The FEAT-412 "worktrees live outside the tracked repo root" paragraph.
- The 2026-07-04 shared-stash-protocol HARD RULE (never bare `git stash`/`pop`
  in a per-slice worktree — FEAT-410 wave 2 incident).
- The 2026-07-04 no-`git add -A`-preflight HARD RULE (targeted `git add
  <paths>` only — a concurrent-session sweep-in incident).

These were **not touched** by this session's patch and remain exactly as they
were. A blind `/runner:install --repo .` regen would revert the section to the
template's shorter 3-paragraph form and silently drop all three — confirmed by
this diff, not hypothetical.

## Safe regen sequence, if ever needed later

Not required for this pass (the only real upstream delta was the 4-site
crew:builder fix, now hand-applied), but recorded for future reference:

1. Copy the three local-only Worktree Parallelism paragraphs to a scratch file.
2. Run `/runner:install --repo .`.
3. Diff the regenerated `rules.md` against the scratch content.
4. Re-append the three paragraphs to the regenerated "Worktree Parallelism"
   section verbatim.
5. Re-run `loop.mts doctor --check` and confirm clean.

## Status

- crew:builder fix: **patched, uncommitted** (`.claude/loop/rules.md`,
  `CLAUDE.md`) — awaiting lead review + commit.
- stop-check / approved-slices.md: **routed upstream** (astra/runner repo),
  disposition (RETIRE) recorded above; no local action pending.
- Local HARD RULE additions: **confirmed intact**, no action taken.
- `loop.mts doctor --check`: not re-run as part of this pass (not requested;
  the patch only reworded prose inside an already-passing doc, no schema or
  path changes).
