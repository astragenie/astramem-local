---
status: PASS
---

# Validation Result — SLICE-425 / FEAT-474 (install.sh idempotency + /dev/tty reattach)

Worktree: `C:\work\mega\astramemory-local-worktrees\w474`, branch `feat/feat-474-install-sh-ux`
(HEAD `8d117d6`, working tree clean, no source edits made by this validation). Review is
APPROVED (`.claude/artifacts/crew/reviews/20260712T212744Z-review-result-slice-425-feat-474-install-sh-fix-round.md`).
This pass independently re-executes the real `install.sh` end-to-end against stub `npm` /
`astramem-local` binaries on a scratch-only PATH, rather than re-reading the diff and agreeing
with the reviewer's report. Scope: **AC-1 through AC-5 only**; AC-6..AC-10 belong to SLICE-2 and
were not touched or judged.

## Harness

All stubs and logs live under the session scratchpad
(`.../scratchpad/feat474-validate/`), never under this worktree or the real global install.
- Stub `npm`: intercepts `view <pkg> version` (returns a configured "latest", or fails to
  simulate offline) and `install -g <pkg>` (logs the call, never touches the network or a real
  package).
- Stub `astramem-local`: `--version` reports a configured "installed" version; `init <args>`
  logs its args and whether a subsequent blocking `read` on its stdin got real content or EOF —
  this is what proves whether stdin reattachment actually happened, not just that the script
  didn't crash.
- Real `node` (v24.16.0, satisfies the `>=20` gate) stayed on PATH; the real global npm and the
  real global `astramem-local` (0.3.4, at `~/.bun/bin`) were deliberately excluded from every
  test PATH so nothing here could touch them.
- This box has no real controlling terminal reachable from a non-interactive shell — confirmed
  independently: `/dev/tty` exists as a device node (`crw-rw-rw- ... 5, 0`) but
  `(exec < /dev/tty)` fails with `No such device or address` outside an interactive session. That
  gave a **natural, unmodified** AC-5 environment (no synthetic setup needed) but meant AC-4
  (successful reattach) needed an isolated variant — see below.

## AC-1 — Skip reinstall when already current

Stub `astramem-local --version` → `1.2.3`; stub `npm view astramem-local version` → `1.2.3`; no
`FORCE`. Ran the unmodified `install.sh`:
```
Node.js v24.16.0 OK (>= 20 required).
astramem-local 1.2.3 is already the latest version — skipping reinstall (set FORCE=1 to force).
Installed: 1.2.3
```
`install -g` log file: empty (no invocation). `npm` log: only the `view` call, never `install`.
Exit 0. Script proceeded past the skip into step 4 (init-wizard step, unaffected per AC-1's
"steps 4 onward are unaffected" clause). **PASS.**

## AC-2 — FORCE=1 overrides the skip

Same already-current state as AC-1, `FORCE=1` set:
```
Node.js v24.16.0 OK (>= 20 required).
FORCE is set — installing astramem-local@latest globally...
+ astramem-local@1.2.3
Installed: 1.2.3
```
`install -g` log: `install -g astramem-local` recorded. Exit 0. **PASS.**

## AC-3 — Version mismatch always reinstalls (both sub-cases)

**3a — installed older than latest** (stub version `1.0.0`, latest `1.2.3`, no FORCE):
```
Installing astramem-local@latest globally...
+ astramem-local@1.2.3
```
`install -g` log: recorded. Exit 0.

**3b — nothing installed at all**: PATH built with only a stub `npm` and no `astramem-local`
binary present anywhere (so `command -v astramem-local` legitimately fails at the top of the
script, `installed_version=""`). The stub `npm`'s `install -g` handler was made to drop the
`astramem-local` stub binary into the same directory post-install, mirroring what a real
`npm install -g` would do — this was a harness bug I hit and fixed myself: my first attempt at
this scenario exited 1 with "install completed but 'astramem-local' is not on PATH" because my
stub `npm install` didn't actually place a binary, which is a test-harness gap, not a defect in
`install.sh` (confirmed by reading the script's own line-79 PATH re-check, which is doing exactly
what it should). After fixing the stub:
```
Installing astramem-local@latest globally...
+ astramem-local@1.2.3
Installed: 0.0.0
```
`install -g` log: recorded. Exit 0. (`Installed: 0.0.0` is a cosmetic stub artifact — my
`astramem-local` template defaults its `--version` to `0.0.0` when no version-file override is
wired for the post-install re-check; irrelevant to what's being asserted, which is that
`npm install -g` actually ran.)

**Bonus — `npm view` fails / offline** (latest resolves empty, installed version present and
non-empty): `install -g` still logged, i.e. no false-skip on a failed version lookup. Exit 0.

All three sub-cases plus the offline bonus: **PASS**, no false-skip in any case.

## AC-4 — /dev/tty reattach keeps the wizard interactive when piped

Since this sandbox cannot open a real controlling terminal non-interactively (see harness note
above), I extracted the exact reattach block (install.sh lines 102-119, logic byte-for-byte
unchanged) into a scratch-only copy with every literal `/dev/tty` path substituted for an
openable stand-in file (`diff` against the real file confirms the *only* difference is that
literal string, everywhere it appears including in comments). Piped genuinely irrelevant content
into stdin (simulating `curl | bash`) and ran it:
```
$ echo "irrelevant-piped-content" | bash install-ac4.sh --some-arg
Node.js v24.16.0 OK (>= 20 required).
astramem-local 1.2.3 is already the latest version — skipping reinstall (set FORCE=1 to force).
Installed: 1.2.3

Stdin isn't a terminal (this script was likely piped in, e.g. curl | bash).
Re-attached to <standin-tty-path> — running 'astramem-local init' with args: --some-arg ...
init called with args: --some-arg
EXIT=0
```
The stub `astramem-local init`'s own log (what it actually read off its stdin after the `exec`):
```
init called with args: --some-arg
stdin-read: [hello-from-standin-tty]
```
The value read is `hello-from-standin-tty` — the stand-in target's content — **not**
`irrelevant-piped-content`, the original piped stdin. That's the load-bearing evidence: stdin was
genuinely swapped mid-script by the `exec < <standin>` reattach, not merely papered over. Args
(`--some-arg`) passed through `"$@"` correctly too. **PASS.**

## AC-5 — Graceful fallback when no /dev/tty is openable

Ran the real, completely unmodified `install.sh` (no substitution) with stdin piped (simulating
`curl | bash`) on this box, which — as independently confirmed above — has no real controlling
terminal reachable non-interactively. Timed to prove no hang:
```
$ echo "piped-content-simulating-curl" | timeout 15 bash install.sh --no-hook
Node.js v24.16.0 OK (>= 20 required).
astramem-local 1.2.3 is already the latest version — skipping reinstall (set FORCE=1 to force).
Installed: 1.2.3

Stdin isn't a terminal (this script was likely piped in, e.g. curl | bash).
No controlling terminal (/dev/tty) is available (e.g. CI or a container),
so the interactive setup wizard can't run here. Finish setup with:

    astramem-local init

EXIT=0  ELAPSED=1s
```
Exit 0, 1 second elapsed (well under the 15s timeout guard), clear next-step guidance printed, no
stray stderr from the failed `/dev/tty` open (the subshell probe's own `2>/dev/null` swallows
it). Every one of the AC-1..AC-3 runs above independently reproduced this same fallback too
(they all show the identical "No controlling terminal" block), so this behavior was exercised
across five separate invocations, not just one. **PASS.**

## Independently re-confirmed: dash/sh early-death is pre-existing, out of scope

Per the task brief, I did not just accept this claim — I reran it myself:
```
$ dash install.sh
install.sh: 24: set: Illegal option -o pipefail
EXIT=2
```
and confirmed via `git log -L24,24:install.sh` that line 24 (`set -euo pipefail`) traces to the
file's original addition commit (`8738876`/blob `037a4a3`), which predates this slice's commits
(`399e831`, `03ceb86`, `4844393`) entirely. `curl | sh` on a dash-based `/bin/sh` has never
worked and is not a regression introduced here — matches what both the FEAT file and the review
artifact already state, now independently verified rather than cited.

## Cleanup / hygiene

All stub binaries, logs, and the AC-4 scratch copy live under the session scratchpad directory
only. No files under `install.sh`, `install.ps1`, `src/`, or any other repo path were edited.
`git status` in this worktree shows a clean tree before and after this validation aside from this
new artifact file.

## Overall

**PASS — AC-1 through AC-5 all hold**, each verified by direct execution against stub binaries
(and, for AC-4, an isolated but logic-identical extraction necessitated by this sandbox having no
real controlling terminal) rather than by inspection alone. No false-skips found in any
version-comparison branch (match / FORCE / older / not-installed / offline-view-failure). The
`/dev/tty` reattach demonstrably swaps stdin to real content, and the no-terminal fallback exits
0 in ~1s with clear guidance and no hang. The dash/sh early-death condition was independently
reproduced and confirmed pre-existing, unrelated to this slice, and correctly out of scope.

**Surprises:** (1) my own stub-`npm` harness initially produced a false failure on the
"nothing-installed-at-all" sub-case of AC-3 because the stub didn't simulate `npm` placing a new
binary on PATH — fixed in the harness itself, not a script defect, but worth flagging since it
underscores why AC-3b needs a PATH that starts genuinely empty of the target binary rather than
just an unset version file. (2) This sandbox's own `/dev/tty` exists as a device node yet is
unopenable outside an interactive session, which turned out to be a convenient, faithful natural
environment for AC-5 but forced the AC-4 test into an isolated (though logic-unchanged) variant.
