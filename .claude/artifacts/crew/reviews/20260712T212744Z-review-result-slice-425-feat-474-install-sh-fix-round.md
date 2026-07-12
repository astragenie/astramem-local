---
task: FEAT-474 / SLICE-425
branch: feat/feat-474-install-sh-ux
reviewer: crew-reviewer (independent)
status: completed
decision: approved
self_approval: false
timestamp: 2026-07-12T21:27:44Z
supersedes: initial round (needs_fix) — no artifact was written for that round; verdict was communicated in-conversation only
---

# Review: FEAT-474 / SLICE-425 — install.sh idempotent skip + /dev/tty reattach (fix round)

## Scope reviewed

- `install.sh` (repo root) — commits `399e831` (original slice), `03ceb86` (dash-safety fix), `4844393` (handoff update).
- Builder's handoff: `.claude/artifacts/crew/handoffs/feat474-slice425-complete.md` (original) plus the fix-round note recorded in `4844393`.
- Confirmed out of scope and untouched: `install.ps1`, `src/service/reinstall.ts`, `src/cli/init.ts`. AC-6..AC-10 (root/sudo, PATH guidance, config-dir perms) are explicitly slice 2 — their absence is not a defect here.
- Diff scope note: `git diff main..feat/feat-474-install-sh-ux` also shows 4 unrelated files (ADR-001, FEAT-453 spec/handoff/backlog) — verified via `git show --stat` on each of the three feature-branch commits that these are pre-existing drift from `main` advancing past this branch's merge-base (an unrelated FEAT-453 reconciliation, commit `0e5e10f`), not scope creep introduced by this builder.

## Initial-round finding and how it was closed

**[NEEDS_FIX, initial round] `install.sh` (then line 101) — bare `exec < /dev/tty` inside an `if` condition is fatal under dash/sh, not just risky under bash.** I reproduced the real no-controlling-terminal condition (backgrounded, stdin-detached process — not a substitute file) under bash, dash, and this box's `sh`. Under bash the failing `exec` is correctly exempted from `set -e` inside the `if`-condition and the script falls through gracefully (exit 0, correct message). Under dash/sh — where `exec` is a POSIX "special builtin" — a redirection failure on it terminates the whole shell outright, if-condition or not; the script died mid-run with no fallback message and no next-step guidance. Since `sh install.sh` / `curl | sh` is a plausible real-world invocation of a `curl | bash`-style installer, and `/bin/sh` is dash on Debian/Ubuntu/Alpine, this was a genuine risk.

**Fix applied (`03ceb86`):** wraps the probe in a subshell — `if [ -e /dev/tty ] && (exec < /dev/tty) 2>/dev/null; then exec < /dev/tty; ...` — so a failed open only kills the subshell; the real `exec < /dev/tty` in the if-body only runs once the probe has proven it's safe. This is exactly the pattern I verified independently in the initial round. Re-verified now:
- Reran the no-tty scenario (backgrounded, stdin from `/dev/null`, real ENXIO on `/dev/tty`) under bash, dash, and `sh`: all three now fall through cleanly, exit 0, correct fallback message printed, **no stray diagnostic** (the subshell's own `2>/dev/null` also swallows the "No such device or address" line that leaked in the original round — this incidentally closes my [LOW] stderr-leak finding from round 1 too, as the builder's handoff claims; confirmed, not just asserted).
- Reran the successful-reattach path (substitute readable file standing in for `/dev/tty`, both bash and dash): probe succeeds, real `exec` in the if-body succeeds, `read` on the reattached stdin returns the expected content, script continues correctly under both shells.
- `bash -n install.sh` clean.

**Reframing on severity, verified independently:** the team lead's note that the full script never reaches this logic under dash/sh at all is correct — I ran the complete, unmodified `install.sh` under dash from a clean invocation and it dies at line 24 (`set -euo pipefail`; `install.sh: 24: set: Illegal option -o pipefail`) before any of step 3 or step 4 executes. Confirmed via `git log -L24,24:install.sh` that this line traces to the file's original commit (`037a4a3`), predating this slice entirely and untouched by it. So the practical blast radius of the original bug was "loud, early, nothing-installed failure at line 24" rather than the more dangerous "silent mid-install death" I'd initially flagged — the subshell fix is still correct, costs nothing, and is the right hardening for if/when a future slice makes this script portable to dash (tracked as slice 2 territory per the team lead), so it should stay regardless.

## Other round-1 items — re-confirmed still correct, no regression from the fix

- **Version comparison (AC-1/AC-2/AC-3).** Re-ran against stub `node`/`npm`/`astramem-local` binaries after the fix commit: match → skip, no `npm install -g` call logged; `FORCE=1` → override, both calls logged; mismatch → install runs; clean PATH with no `astramem-local` present at all (AC-3b) → empty `installed_version` correctly routes to install. All unchanged and correct after the fix (the fix only touches step 4, step 3 is unaffected — confirmed by diff).
- **Offline / npm-view-failure.** Re-confirmed `latest_version=""` still falls through to install, not a false skip.
- **`exec astramem-local init "$@"` passthrough.** Unaffected by the fix; still correct.

## Residual notes (not blocking)

- **[LOW/INFO]** The fix opens `/dev/tty` twice in the success path (once in the subshell probe, once for real in the if-body) — a narrow TOCTOU window exists in theory (device revoked between the two opens) where the second, unguarded `exec < /dev/tty` could itself fail under dash and die without the subshell's protection. This is an extremely unlikely race for a controlling terminal in practice and not worth blocking on; not flagging as a defect, just recording so nobody is surprised if it's ever raised again.
- No `shellcheck` was run (still unavailable on this box per the handoff) — `bash -n` plus the direct multi-shell execution tests above are the verification basis.

## Decision

**approved** — the dash/sh fatal-exit bug from round 1 is fixed and independently re-verified under bash, dash, and sh for both the failure-fallback and successful-reattach paths; the round-1 stderr-leak note is also resolved as a side effect. AC-1 through AC-5 all hold, re-confirmed by direct execution against stub binaries, not by inspection alone. Scope is clean (only `install.sh` + handoff touched by this builder's commits). No new findings at MEDIUM or above. Clear to merge.
