---
status: PASS
---

# Validation Result — SLICE-422 / FEAT-466 (keystore per-configDir scoping + secrets.env authoritative)

Worktree: `C:\work\mega\astramemory-local-worktrees\w466`, branch `feat/feat-466-keystore-scope`
(head `05108e9`, not switched, no source edits made). Review PASS after 1 fix round. This slice
touches the exact machinery from the 2026-07-10 credential-collision incident, so every scenario
below ran under the documented `ASTRA_MEMORY_TEST_FORCE_KEYFILE=1` bypass, and the real OS
credential store's state was captured and diffed before/during/after the entire run, not just
at the end.

`bun install` (no changes) + `bun run build` (`tsc -p .`): clean.

## Safety verification method (read this first — it's the load-bearing evidence for every scenario)

Captured a full `cmdkey /list` output as the baseline **before touching anything** (`git log`,
`bun install`/`build` only had run at that point). Re-captured and `diff`'d against that baseline
at four checkpoints: after Scenario 1's `init`, immediately before Scenario 5's `rotate`,
immediately after `rotate`, and as a final check after all daemons were killed. **Every diff
returned exit 0 (byte-identical)** — the real Windows Credential Manager entries for
`astramem-local` (`sync-device-token`, `db-key`, `bearer` — the exact three legacy entries
involved in the original incident) were never modified at any point in this run. Additionally
read the actual bearer *value* via the app's own `readBearer()` function (pointed at a
nonexistent configDir so it falls through to the legacy read-only path) at baseline and at the
end: both reads returned the identical value the production daemon was restored to after the
original incident (`bfd63f62...`), confirming byte-level value stability, not just entry-count
stability. Production daemon (port 7777, PID 20096) confirmed running and undisturbed at the end.

I deliberately did NOT exercise the "scoped" (real, non-legacy-colliding) OS-credential-store
identity path live in this validation, even though FEAT-466's own design means a scoped write
would create a new, non-colliding entry rather than touching the legacy one — the team lead's
rails specified the bypass for every scenario, and disabling it wasn't explicitly authorized. That
path's correctness rests on the review's own stubbed-`Entry` unit tests (confirmed genuine by the
reviewer, not re-verified live here) — flagging as a residual, intentionally out-of-scope gap.

## Scenario 1 — THE incident scenario, now safe

```
APPDATA=<sandbox dirA> ASTRA_MEMORY_INIT_NONINTERACTIVE=1 ASTRA_MEMORY_TEST_FORCE_KEYFILE=1 \
  ASTRA_MEMORY_INIT_DATADIR=<sandbox dirA data> node dist/cli/index.js init
```
Completed successfully (`init` needs a real file-based dataDir, not `:memory:`, for its DB
migration step — used a real sandboxed directory instead). Confirmed:
- `bearer.key` written under the sandbox configDir, containing the new token.
- `secrets.env` contains `MEMORY_BEARER=<same token>` — matches `bearer.key` byte-for-byte.
- `cmdkey /list` immediately after: **identical to baseline** (diff exit 0) — no new entries, no
  modified entries, not even a new *scoped* entry (the bypass short-circuits before any OS-store
  code path is reached at all).

**AC-3/AC-4 confirmed live**, not just via the review's unit tests.

## Scenario 2 — Boot from that init's output, auth via secrets.env value (not `ASTRA_MEMORY_TOKEN`)

Booted `serve --port 17810` with the sandbox `APPDATA` + bypass set, **no** `ASTRA_MEMORY_TOKEN`
override. Boots clean, `/health` → 200. Then, using the literal bearer value copied from
`secrets.env` (not an env override), POSTed `/ingest/transcript`:
- Correct sandbox bearer → **200**.
- Wrong bearer → **401**.
- No bearer → **401**.

Proves the full resolution chain (`resolveBearerToken` → `readBearer(configDir)` →
`ASTRA_MEMORY_TEST_FORCE_KEYFILE` bypass → `bearer.key` file) works end-to-end for real request
auth, not just that the file gets written.

## Scenario 3 — Doctor identity reporting

```
node dist/cli/index.js doctor --port 17810   (same sandbox APPDATA + bypass)
```
```
✓ Encryption at rest: encryption: on (key-file)
✓ Bearer token location: bearer: OS credential store (identity: key-file)
```
Truthfully reports `identity: key-file` for the bypass path (AC-5's reporting mechanism is live
and correct for this identity value). The "scoped" and "legacy" identity values were not
exercised live in this run per the safety-rail note above — confirmed correct by the review's own
independent code-reading and stubbed-Entry tests instead.

## Scenario 4 — Two-configDir isolation, live, simultaneous

Ran a second `init` against `dirB` (bypass on) → distinct bearer minted. Booted both daemons
simultaneously: dirA on port 17810 (later restarted on 17812 for Scenario 5), dirB on port 17811.

| request | result |
|---|---|
| dirB daemon, dirB's own token | **200** |
| dirB daemon, dirA's token (cross) | **401** |
| dirA daemon, dirB's token (cross) | **401** |
| dirA daemon, dirA's own token again | **200** (no state corruption from the cross-attempts) |

**AC-1 confirmed live at the request-auth level**: two independent configDirs produce two
independent, non-interfering credential identities, with neither daemon accepting the other's
token.

## Scenario 5 — Sandboxed rotate under bypass

Captured `cmdkey /list` immediately before rotate (diff vs. original baseline: exit 0, still
unchanged). Ran:
```
APPDATA=<sandbox dirA> ASTRA_MEMORY_TEST_FORCE_KEYFILE=1 node dist/cli/index.js token rotate
```
`secrets.env`'s `MEMORY_BEARER=` updated from `7953a029...` to a new value `1ef7a132...`.
Immediately re-checked `cmdkey /list`: **still byte-identical to baseline** (diff exit 0) — this
is the single most important assertion in this validation, since `rotateToken()` sets
`writeThroughLegacy: true` unconditionally (it always intends to write the legacy identity for
rollback protection); confirmed by reading `storeBearer`'s source that the
`ASTRA_MEMORY_TEST_FORCE_KEYFILE` check returns early via the file path **before** the function
ever evaluates `opts.writeThroughLegacy`, so the bypass genuinely prevents the legacy write from
happening at all, not just from succeeding. Also re-confirmed the legacy bearer *value* via
`readBearer()` — unchanged.

Restarted the dirA daemon (new port 17812, same sandbox `APPDATA`, bypass still on) to pick up the
rotated token:
- Old token → **401** (correctly invalidated).
- New token → **200** (correctly accepted).

**Rotate's core promise (old token invalid, new token works after restart) confirmed live, with
the OS-store-untouched guarantee proven by direct before/after diff, not by trusting the code
comment.**

## Cleanup

All four spawned daemons (dirA x2 across the restart, dirB) confirmed healthy via `/health`
immediately before being killed by their own PIDs; confirmed gone afterward. Final `cmdkey /list`
diff against the very first baseline: **exit 0, byte-identical**. Final legacy bearer value read:
**identical** to the value restored during the original 2026-07-10 incident. Production daemon
(port 7777, PID 20096) confirmed running throughout and at the end. No git operations beyond
read. No source files edited (worktree `w466` only).

## Overall

**PASS.** All 5 scenarios behave correctly through the real daemon/CLI, with the central safety
property — the real OS credential store is completely untouched by any operation in this
validation, including a `token rotate` that always intends a legacy write-through — proven by
direct `cmdkey /list` diffing at four checkpoints plus a value-level `readBearer()` check, not
assumed from the code's own design. AC-1 (two-configDir isolation) and AC-3/AC-4 (bypass leaves
the OS store untouched) are confirmed live, not just at the unit level. One intentional scope
limitation: the "scoped" (real, non-colliding) OS-credential-store identity path was not
exercised live in this pass per the stated safety rails — its correctness rests on the review's
own stubbed-Entry unit-test verification.
