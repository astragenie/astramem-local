---
status: PASS
---

# Review Result — SLICE-422 / FEAT-466 (keystore per-configDir identity scoping)

- Worktree: `C:\work\mega\astramemory-local-worktrees\w466`, branch
  `feat/feat-466-keystore-scope`, commits `e7cc497` (original), `05108e9` (review fix)
  vs `main`/`c947310`
- Reviewer: independent review (read-only, no edits made, worked only in this worktree)
- **Original verdict: NEEDS_FIX** (below) — **Final verdict (after `05108e9`): PASS.**
  See re-review section at the end. Original finding: one HIGH-severity finding,
  reproduced end-to-end with the
  real functions: a rollback to a pre-FEAT-466 daemon binary can silently resolve a
  **stale** bearer (or fall through to the hard-coded `'devtok'` default), because
  `secrets.env` is not reliably authoritative and the legacy OS-store identity is
  never updated by the new scoped-write path. AC-1 through AC-6's own stated
  fixtures, the read-only-fallback guarantee, test honesty, and the sync-token
  scope boundary all check out; path-normalization is a real but currently
  unreachable hardening gap, not a live bug.

## Finding 1 (HIGH — reproduced end-to-end): rollback to a pre-FEAT-466 binary can resolve a stale bearer, with secrets.env unable to rescue it

**Files: `src/storage/keystore.ts:282-303` (`storeBearer`), `src/cli/token.ts:60-67`
(`rotateToken`), `src/config/secrets.ts:41-45` (`writeSecrets`).**

Traced the actual bearer-resolution precedence documented at the top of
`bearer-keystore.ts` (CLI flag → env var → OS credential store → `secrets.env` →
`'devtok'` default) against what `storeBearer`/`rotateToken` actually persist, then
reproduced it end-to-end with the real functions (a stubbed in-memory credential
store standing in for the OS keychain, not a mock of the logic under test):

```
Step 0 (pre-existing install): legacy OS-store entry (astramem-local:bearer) = T_legacy

Step 1 (NEW binary runs `token rotate`, credential store healthy):
  rotateToken() -> storeBearer(newToken, configDir) succeeds (stored: true)
  -> writeSecrets({ bearer: undefined, ... }) is called (stored ? undefined : newToken)
  -> secrets.env is fully rewritten with NO MEMORY_BEARER= line at all
  -> OS-store state after rotate:
       astramem-local:bearer                 = T_legacy        (untouched — never written by the new code)
       astramem-local:<hash(configDir)>:bearer = T_new          (the only place the new token landed)

Step 2 (rollback: reinstall --rollback to a pre-FEAT-466 binary):
  the old binary has no scoping concept at all — it reads the single
  unscoped identity directly (what FEAT-466 now calls "legacy")
  -> reads T_legacy, NOT the token the operator was just issued (T_new)

Step 3 (does secrets.env rescue it?):
  secrets.env contains no MEMORY_BEARER= line at all (wiped in step 1)
  -> the old binary's own secrets.env fallback also finds nothing
  -> falls through to the hard-coded 'devtok' default
```

This is a genuine, reproducible authentication-state divergence, not a hypothetical:
after any `token rotate` or fresh `init` on this release (the very first release with
scoped identities — meaning the *immediately preceding* release is, by construction,
always a pre-FEAT-466 rollback target), a `reinstall --rollback` lands the daemon on
either a **stale** bearer (if a legacy entry pre-dates this upgrade) or the
**well-known `'devtok'` default** (on a fresh install with no legacy entry) — while
the actual client (plugin, or an operator who copied the freshly-rotated token) is
still using the new one. The practical failure mode is an authentication mismatch:
legitimate requests carrying the correct (new) bearer get rejected by the rolled-back
daemon, or — worse, in the fresh-install/no-legacy-entry case — the daemon silently
reopens the exact hard-coded-default-credential window SEC-10 was built to close.

**Root cause is the interaction of two independently-reasonable pieces, not either
one alone:** (a) `storeBearer` *always* writes to the scoped identity only, never the
legacy one (correct per AC-1 — this is what prevents the original incident), and (b)
the pre-existing (not part of this diff — confirmed via `git diff`, `rotateToken`'s
`stored ? undefined : newToken` line is unchanged by FEAT-466) SEC-10 design where
`secrets.env` only ever carries the bearer when the OS-store write *failed* — so it's
a fallback-of-last-resort, not a synced mirror. Pre-FEAT-466, that was safe: the OS
store was a single global identity, so any binary version reading it (old or new)
converged on the same value. FEAT-466's scoping breaks that convergence specifically
for the rollback direction: **`secrets.env` is not reliably authoritative** (it's
empty of a bearer whenever the OS store succeeds, which is the common case), **and
the OS store can and does win with a stale/absent value** on a binary that predates
scoping.

**This is exactly what the review focus asked to state explicitly, and the answer is:
secrets.env is NOT authoritative on rollback, and the legacy OS-store entry is left
stale forever** (confirmed by code inspection: no code path ever writes to the legacy
identity after this diff) — **and doctor does not warn about this**, because the
new `identity: scoped|legacy` reporting (AC-5) only exists in the post-FEAT-466
binary; a rolled-back OLD binary has no such doctor enhancement to surface that it's
reading a stale credential.

**Recommended fix direction (not prescriptive):** the cheapest closure is to also
write the new bearer to `secrets.env` unconditionally (or at least whenever a scoped
write succeeds), so a rollback's `secrets.env`-fallback path always has the current
value available even though the legacy OS-store identity can't be kept in sync short
of writing to it too (which would reintroduce the original global-collision risk this
FEAT closes). Writing to secrets.env unconditionally does not carry that collision
risk, since `secrets.env` is already scoped to `configDir` structurally (one file per
install), unlike the OS credential store's global namespace. Given the current
design's own logic ("secrets.env is fallback-of-last-resort, kept empty when the
store succeeds, to avoid persisting the bearer in plaintext unnecessarily") this is a
genuine trade-off, not a one-line fix — flagging for the team's call, but the current
state leaves a real, reachable rollback hazard un-mitigated and un-warned-about.

## 2. Windows path normalization before hashing — real gap, but no live divergence found in this codebase's actual call sites

`scopedService(configDir)` (`keystore.ts:72-75`) hashes the raw `configDir` string
with zero normalization — confirmed directly: `C:\Users\serge\...`,
`c:\users\serge\...` (case-folded), `C:/Users/serge/...` (forward slashes), and a
trailing-backslash variant all hash to four completely different service names.
This is a real latent fragility.

However, traced every actual call site in this repo (not just the 4 files this
slice touches) that constructs a `configDir` for a normal (non-isolated) production
run — `init.ts`, `pair.ts`, `token.ts`, `doctor/checks.ts`, and
`resolve-runtime.ts`'s non-isolated branch — and **all of them consistently call the
same `defaultConfigDir()` function** (`config/datadir.ts`), which is a pure,
deterministic function of `process.env.APPDATA` (or its fallback) via `path.join` —
same environment variable, same `path.join` normalization, every call, within a
given machine/session. I could not construct a realistic scenario where two
call sites in this codebase, under normal (non-isolated) operation, would compute
`configDir` with a different string spelling for what is logically the same
directory. `resolve-runtime.ts`'s isolated-mode branch *does* compute `configDir`
differently (`join(dataDir, 'config')`), but `resolveBearerToken` explicitly skips
the OS-credential-store/secrets.env steps entirely under isolation (steps 3+4 are
bypassed, collapsing to CLI/env/ephemeral-token only per that file's own header
comment) — so the bearer path specifically can't be hit by the isolated-mode
divergence either.

**Not blocking.** Recommend a one-line hardening (case-fold + `path.resolve` +
strip a trailing separator before hashing in `scopedService`) as cheap
defense-in-depth against a future call site that doesn't route through
`defaultConfigDir()`, but it's not fixing a currently-reachable bug.

## 3. Read-only legacy fallback — confirmed, no migration/deletion anywhere

Grepped every legacy-identity touch point in `keystore.ts`: both
`getOrCreateCredentialStoreKey` (db-key) and `lookupBearer` (bearer) only ever call
`.getPassword()` on the legacy `EntryCtor(SERVICE, ACCOUNT)` / `EntryCtor(SERVICE,
BEARER_ACCOUNT)` — no `.setPassword()`, no `.deletePassword()` on either legacy
identity anywhere in the file. AC-2's "read-only, no migration write" claim holds.

## 4. Test honesty — `__setEntryCtorForTests` throwing-ctor proof is genuine, with one clarifying (non-blocking) note

Confirmed `stubEntryThatMustNeverBeConstructed()` (`tests/security/
bearer-keystore.test.ts:190-207`) is used by both the `storeBearer` and `readBearer`
AC-3/AC-4 tests — the stub's constructor unconditionally throws, so a passing test
genuinely proves no `Entry` is ever constructed on the bypass path for either
function, not just that the resulting map stays empty. `token.test.ts` and
`bearer-keystore.test.ts` both import the real `Entry` type only for type-annotation
purposes (`as unknown as typeof Entry` on stub classes) — never instantiated.

**One clarifying note, not a finding against this diff:** `tests/security/
encryption.test.ts` does contain a test that constructs a **real** `Entry` and
round-trips a value against the actual OS credential store (`'astramem-local-test-
keystore-smoke'`, a PID-scoped, clearly-non-production identity, cleaned up via
`deletePassword()` in a `finally`). Confirmed via `git diff`/`git show` at
`c947310` that this test **predates FEAT-466 entirely** (traces back to the original
encryption-at-rest feature, commit `656f348`) — it is not introduced or modified by
this slice. The handoff's "Safety note" claim ("No test in this slice writes to the
real OS credential store") is accurate as scoped to this slice's own new/changed
tests; worth noting only so the claim isn't misread as "the whole file never touches
the real store."

## 5. Sync-token scope boundary — confirmed accurate, no half-migration

`git diff` on `keystore.ts` confirms `storeSyncToken`/`readSyncToken`/
`SYNC_TOKEN_ACCOUNT` are untouched except for an added comment block explicitly
documenting the intentional exclusion — no partial scoping, no inconsistency between
the (scoped) bearer/db-key paths and the (still-unscoped) sync-token path. Matches
the handoff's stated non-goal exactly.

## 6. Gates — re-run independently, matches builder's numbers

- `bunx tsc --noEmit`: clean, no output.
- `bun vitest run tests/security tests/doctor tests/cli`: **39 files / 389 tests
  passed, 0 failed.**
- `bun run test` (full suite, in-worktree): **199 files / 2373 tests passed, 6
  skipped, 0 failed** — matches the builder's claimed `199 test files, 2373 passed,
  6 pre-existing skips, 0 failures` exactly.

## Recommendation

Fix Finding 1 before merge (or, at minimum, explicitly document the rollback hazard
in the release notes/CHANGELOG and consider a doctor WARN for "no legacy bearer
found and secrets.env has no MEMORY_BEARER line" as a partial mitigation) — this is a
reproducible authentication-state divergence on rollback, the very next operational
path for anyone who upgrades to this release, with a worst case (fresh install, no
legacy entry) of silently reopening the hard-coded `'devtok'` default. Finding 2 is
real but not currently reachable through any call site in this codebase — a
low-priority hardening item, not a blocker. Everything else — the scoped/legacy
precedence logic itself, the read-only-fallback guarantee, the doctor identity
surfacing (AC-5), test honesty, and the sync-token exclusion — is genuinely correct
and well-tested.

---

## Re-review — fix commit `05108e9`

### Fix shape, confirmed by diff

`git diff e7cc497..05108e9`: (1) `secrets.env` is now unconditionally authoritative
for the bearer — `init.ts` and `token.ts` both removed the `stored ? undefined :
token` conditional, so `MEMORY_BEARER=` is always written regardless of OS-store
success. (2) `storeBearer()` gained an opt-in `StoreBearerOpts.writeThroughLegacy`;
when set, it best-effort writes the rotated token into the legacy unscoped identity
too, in its own inner `try/catch` separate from the outer one governing the scoped
write's success/failure. (3) `scopedService()` now normalizes `configDir` via a new
`normalizeConfigDir()` (`path.resolve` + Windows-only case-fold) before hashing.
(4) 9 new tests across `bearer-keystore.test.ts` (7) and updated assertions in
`token.test.ts` (2 tests updated to match the new always-write behavior).

### 1. `writeThroughLegacy` containment — confirmed fully scoped, no propagation risk

Grepped every non-test call site of `storeBearer(`:
- `src/cli/init.ts:748` — no third argument (opts defaults to `{}`, `writeThroughLegacy`
  is falsy). Confirmed by diff: `init.ts`'s call is unchanged in this respect.
- `src/cli/token.ts:74` — the only call site passing `{ writeThroughLegacy: true }`.
- `src/storage/bearer-keystore.ts:124` (the pre-existing "opportunistic promotion"
  from `resolveBearerToken`, unrelated to this fix round) — no opts passed either.

So exactly one call site in the entire codebase sets the flag, matching the design
intent precisely. Then checked reachability: `rotateToken` (the only function that
can set `writeThroughLegacy`) is called from exactly two places — `tokenCommand`'s
`'rotate'` subcommand (`src/cli/index.ts:146`, requiring an explicit `astramem-local
token rotate` invocation by a human) and `tests/cli/token.test.ts` (uses tmp
directories and a fully stubbed `Entry`, confirmed never touching a real store).
Grepped `scripts/` and `src/` for any other caller of `rotateToken`/`tokenCommand` —
none found. Unlike `init` (which *was* reachable from a sandboxed/automated e2e
harness invocation — that's the exact mechanism that caused the original incident),
there is no automated or scripted path in this repo that invokes `token rotate`
today. A sandboxed test calling `rotate` against a real store would indeed be able
to clobber the production legacy entry (the write-through has no scoping guard of
its own beyond "only rotate sets this flag") — but that requires a human explicitly
running `token rotate`, not an unattended process, which is a materially different
risk profile from the original `init`-in-CI incident this FEAT closes.

### 2. `simulateOldBinaryResolve` honesty — verified against the actual historical source, not just the test's own comment

Ran `git show c947310:src/storage/bearer-keystore.ts` myself and confirmed
`resolveBearerToken`'s real precedence at that commit (excluding CLI/env/isolated,
which aren't in question): `readBearer()` (OS store, unscoped at that commit) FIRST,
then `readBearerFromSecretsFile()`, then the hard-coded `'devtok'` default. This is
an exact match for `simulateOldBinaryResolve`'s implementation
(`bearer-keystore.test.ts:463-474`) — the test helper's mirroring claim is honest,
not merely asserted in a comment.

Confirmed test (a) ("upgraded install") covers the specific case asked about: it
seeds the legacy identity with a **different, stale token**
(`store.set('astramem-local:bearer', 'stale-legacy-token')`) representing a
pre-existing pre-upgrade entry, then asserts the old-binary simulation resolves the
**new** rotated token, not the stale one, after `rotateToken`'s write-through. This
is the exact scenario the re-check asked me to confirm coverage for, and it's there.

### 3. AC-2 exception disclosure — well-documented in the places that govern behavior; one minor completeness gap noted

The exception is clearly and prominently documented in the code itself
(`keystore.ts`'s bearer-section header comment, and `StoreBearerOpts`'s own JSDoc,
both explicitly call it "a deliberate, narrowly-scoped exception to the 'legacy is
read-only' rule (AC-2)") and in the handoff's fix-round-2 section. **One minor,
non-blocking gap**: `FEAT-466.md`'s own itemized AC-2 text (in
`.claude/artifacts/loop/backlog/in-progress/FEAT-466.md`) was not amended to mention
the write-through exception — it still only describes the (unaffected, still-true)
read-fallback behavior. This isn't a *silent* drift (the exception is disclosed
everywhere a maintainer would actually look — the function doc, the file header, the
handoff), just a formal-AC-list completeness nit; recommend a one-line addendum to
AC-2's text for a future reader who only skims the backlog file, but not a blocker.

Confirmed the legacy write is genuinely best-effort and cannot fail rotation: the
`writeThroughLegacy` write sits in its own inner `try/catch`
(`keystore.ts:344-352`), separate from the outer `try/catch` governing the scoped
write — if the legacy write throws, it's caught, WARNs, and the function still
returns `{ stored: true, source: 'credential-store', identity: 'scoped' }` as normal;
rotation itself cannot fail because of a legacy-write problem.

### 4. Normalization — win32-only case-fold confirmed correct on both branches

`normalizeConfigDir` (`keystore.ts:76-79`): `process.platform === 'win32' ?
resolved.toLowerCase() : resolved`. Extracted the identical ternary into a standalone
script and exercised both branches directly: the win32 branch folds
`C:\Users\Serge\AppData` and `c:\users\serge\appdata` to the same string; the
non-win32 branch correctly leaves them distinct (case preserved), which is the
correct behavior for case-sensitive Linux filesystems — folding case there would
wrongly collide two genuinely distinct directories. One test-coverage caveat worth
noting: the shipped "Windows-only" test (`bearer-keystore.test.ts:532`) gates itself
off entirely (`if (platform() !== 'win32') return;`) when run on non-Windows CI, so
there's no *executable* assertion anywhere in the suite proving the non-win32 branch
doesn't fold case — only this review's direct extraction-and-test of the logic, plus
straightforward code reading (a one-line ternary), backs that claim. Low-severity
observation, not a blocker given how simple and directly-readable the branch is.

### 5. Gates, re-run independently

- `bunx tsc --noEmit`: clean, no output.
- `bun vitest run tests/security tests/cli tests/doctor`: **39 files / 398 tests
  passed, 0 failed** (up from 389 — the 9 new tests) — matches the builder's claimed
  numbers exactly.
- `bun run test` (full suite, in-worktree): **199 files / 2382 tests passed, 6
  skipped, 0 failed** (up from 2373) — matches the builder's claimed numbers exactly.

### Final status: PASS

The rollback hazard (Finding 1) is genuinely closed via the "secrets.env
unconditionally authoritative" design plus the scoped-and-legacy write-through on
rotate specifically, verified against the actual pre-FEAT-466 source rather than a
paraphrase of it. The `writeThroughLegacy` exception is tightly contained to a
single, human-triggered call site with no automated/sandboxed reachability. The
configDir-normalization hardening (Finding 2) is correctly implemented on both
platform branches. No new issues found. **w466 is ready for validation** — the
keystore-scoping change involves real OS credential-store interaction and a
rollback/timing-sensitive design, so a boot-level validation pass (a real `init` +
`token rotate` + simulated rollback check, or at minimum confirming `doctor`'s new
`identity: scoped|legacy` row against a live install) carries genuine additional
signal beyond the unit-level evidence here, unlike the FEAT-465 loader change.
