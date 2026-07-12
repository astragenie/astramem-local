# FEAT-474 / SLICE-425 — install.sh idempotent skip + /dev/tty reattach — build complete

**Objective**: Make `install.sh` idempotent (skip reinstall when already at the
npm-latest version, `FORCE=1` escape hatch) and keep the `init` wizard
interactive when the script is piped stdin (`curl | bash`) by re-attaching
`/dev/tty`, with a graceful fallback when no controlling terminal exists.

**Owner**: builder (this session), single-session mode.

**Scope**: `install.sh` only, AC-1..AC-5 of FEAT-474. AC-6..AC-10 (slice 2,
root/sudo/PATH/perm hardening), `install.ps1`, `src/service/reinstall.ts`, and
`src/cli/init.ts` were explicitly out of scope and untouched — confirmed via
`git status --short` showing only `install.sh` modified.

## Changes

`install.sh` (repo root, worktree `C:\work\mega\astramemory-local-worktrees\w474`,
branch `feat/feat-474-install-sh-ux`):

1. **Step 3 (install/upgrade)** — added an idempotency check before
   `npm install -g astramem-local`:
   - Reads `installed_version` via `astramem-local --version` if the command
     exists (empty string if not installed).
   - Reads `latest_version` via `npm view astramem-local version`.
   - `FORCE` set (any non-empty value) → always reinstalls.
   - Else if `installed_version` is non-empty and equals `latest_version` →
     skip, print "already the latest version" message.
   - Else (not installed, older version, or `npm view` failed so
     `latest_version` is empty) → install, matching prior unconditional
     behavior. This means a real upgrade or an offline `npm view` never
     false-positives as "already current."
2. **Step 4 (init wizard)** — replaced the old "bail out and tell the user to
   run `init` themselves" `else` branch with:
   - `[ -t 0 ]` still runs `init` directly when stdin is already a real tty.
   - Otherwise, `[ -e /dev/tty ] && exec < /dev/tty 2>/dev/null` attempts to
     reattach; on success it runs `astramem-local init "$@"` interactively.
   - On failure (no `/dev/tty` device, or open fails, e.g. ENXIO with no
     controlling terminal) it falls through to the original "finish setup
     with `astramem-local init`" message and exits 0 — no hang, no error.

## Evidence (per AC)

All five ACs were exercised by actually running the script (or, for the one
case the sandbox structurally cannot reproduce, the exact isolated control-flow)
— not just read/inspected. Test harness: stub `npm`/`astramem-local` scripts
under a scratch `bin/` prepended to `PATH`, driven by `STUB_INSTALLED_VERSION`
/ `STUB_LATEST_VERSION` env vars, logging every call to a marker file, so real
`npm install -g` was never invoked and the machine's real global install
(`astramem-local 0.3.4` at `~/.bun/bin`) was never touched.

- **AC-1 (skip when already current) — PASS.** `STUB_INSTALLED_VERSION=9.9.9`,
  `STUB_LATEST_VERSION=9.9.9`, no `FORCE`. Output: `astramem-local 9.9.9 is
  already the latest version — skipping reinstall (set FORCE=1 to force).`
  `npm-calls.log` shows only `npm view astramem-local version` — no `npm
  install -g` call — and the script still proceeded into step 4.

- **AC-2 (`FORCE=1` overrides) — PASS.** Same matching-version setup as AC-1,
  but `FORCE=1`. `npm-calls.log` now shows both `npm view ...` and `npm
  install -g astramem-local`, confirming the skip was overridden.

- **AC-3 (version mismatch always reinstalls) — PASS.**
  - 3a: `STUB_INSTALLED_VERSION=1.0.0`, `STUB_LATEST_VERSION=9.9.9`, no
    `FORCE` → `npm install -g astramem-local` ran (logged).
  - 3b: no `astramem-local` stub on `PATH` at all (simulating "not
    installed") → `installed_version` resolves empty → falls to the
    install branch by the same code path proven in 3a (this repo's shared
    dev box has a real global `astramem-local` further down `PATH`, so a
    fully clean "nothing on PATH" run wasn't achievable without disrupting
    that install; the branch taken is identical to 3a's, which was directly
    proven, so this is inspection-plus-partial-run rather than a from-scratch
    isolated proof — flagging honestly rather than overclaiming).

- **AC-4 (`/dev/tty` reattach on piped stdin) — logic proven, not a full
  end-to-end pty test.** This sandbox process tree has no controlling
  terminal at all (`ls -la /dev/tty` shows the device node exists, but
  `exec < /dev/tty` fails with "No such device or address" / ENXIO even
  outside install.sh), and `winpty` (the only pty-allocator on this Windows
  box) itself refuses to run without an interactive console already present,
  so a genuine "has a real controlling terminal, but stdin is piped" state
  could not be constructed here. Instead: (a) ran the actual
  `install.sh`-identical conditional (`[ -e "$TARGET" ] && exec < "$TARGET"
  2>/dev/null; then ... else ... fi` under `set -euo pipefail`) against a
  substitute readable file standing in for `/dev/tty`, confirming the
  reattach branch runs, `exec` swaps stdin, a subsequent `read` sees the
  redirected content, and the script continues without `set -e` aborting on
  the `&&` chain; (b) note that `[ -e /dev/tty ] && exec < /dev/tty` is the
  identical, long-established idiom used by rustup-init.sh, Homebrew's
  install.sh, and nvm's install.sh for exactly this reattach — not a novel
  mechanism being trusted on faith. Flagging this gap explicitly per the
  "don't claim a pass without having run it" instruction — AC-4's control
  flow is verified, but not the literal `/dev/tty`-exists branch inside a
  real piped-curl invocation.

- **AC-5 (graceful fallback, no `/dev/tty`) — PASS, and this one *did* run
  end-to-end for real**, unintentionally as a byproduct of the sandbox's own
  no-controlling-terminal state: running the real `install.sh` here (stdin
  not a tty, `/dev/tty` present as a device but not openable — ENXIO) printed
  `/dev/tty: No such device or address` (harmless — that's `2>/dev/null`'s
  target being visible only because I didn't redirect the outer test
  command's stderr) followed by the correct fallback message and a clean
  exit 0. No hang, no non-zero exit, no daemon/process left running.

## Verification commands run

```
bash -n install.sh                         # syntax check, clean
git status --short                         # only install.sh modified
git diff -- install.sh                     # reviewed, scoped to steps 3 and 4 only
# + the stub-harness runs described above, from scratch temp dir under
#   C:\Users\serge\AppData\Local\Temp\claude\...\scratchpad\feat474-test
```

No `shellcheck` binary available on this box to run as a second check;
`bash -n` syntax check is clean.

## Out of scope, confirmed untouched

- `install.ps1` — not modified.
- `src/service/reinstall.ts` — not modified (its own idempotency/version-parity
  logic is a different mechanism per the FEAT's own note; not reused, not
  duplicated).
- `src/cli/init.ts` — not modified (existing `NON_INTERACTIVE_ENV` map and
  non-interactive gating untouched).
- AC-6..AC-10 (root/sudo handling, chown-back, config-dir perms, PATH
  copy-paste guidance) — not implemented; that's slice 2's scope.

## Risks / open questions

- AC-3b and AC-4 are the two ACs without a fully clean from-scratch
  demonstration on this particular shared dev machine (real global
  `astramem-local` on PATH; no controlling terminal / no pty allocator
  available). The code paths are simple, shared with directly-proven
  branches (AC-3a for AC-3b; the isolated conditional test for AC-4), and the
  `/dev/tty` idiom itself is copied verbatim from well-established installers,
  but a reviewer/validator with access to a real interactive shell (or a Linux
  box with `script`/`setsid`) could close this gap with one more real
  `curl | bash`-style run if it matters for the release bar.
- Did not touch `secrets.env` perms or config-dir perms — those are AC-8,
  slice 2, out of scope here.

## Suggested next handoff

Hand to `crew:reviewer` for independent review of the `install.sh` diff, then
`crew:verifier`/validator to attempt closing the AC-4 pty gap on a machine
with a real controlling terminal (or accept the isolated-logic proof as
sufficient), per the parent loop's gate — this agent does not dispatch those
gates itself per instructions.
