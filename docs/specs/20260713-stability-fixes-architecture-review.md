# Architecture Review: 2026-07-13 Stability Fixes (as a whole)

**Reviewer:** architecture agent (read-only, independent of the parallel `crew:reviewer` correctness
pass). **Scope:** #208 (silent-error audit), #211/#206 (Windows+Unix hang-watchdog), #213 (dashboard
refresh), and in-flight fix-188 (schema content-hash), fix-205 (atom validity), fix-207 (entity
quality), fix-200 (entity-link-rate canary).

**Citation policy, per ADR-015's own header:** several of these branches are being actively rebased
*during this review* — I re-read migration state twice, 20+ minutes apart, and it had already changed
between reads (see §Interactions-1). Anchor on symbol names and the stated verification timestamp
(**2026-07-13, this session**), not on the exact line numbers, several of which will rot within
hours of this document.

---

## Per-change verdicts

### #208 — silent-error audit — **SOUND, with one interaction defect (see §Interactions-3) and one open design question (see §Crux)**

- `CheckResult.inconclusive` (`src/doctor/types.ts:6-17`) and the canonical fix shape — `let db:
  DB | undefined` outside `try`, `catch { return { ok: true, inconclusive: true, ... } }`, `finally {
  db?.close(); }` — is a real, correctly-applied pattern. Verified at `checkUsefulness`
  (`src/doctor/checks.ts:534-561` on this branch): the `finally` closes `db` on every path, and the
  catch sets `inconclusive: true` rather than lying flat `ok: true`. `formatJson`
  (`src/doctor/runner.ts:47-64`) correctly excludes inconclusive from `summary.ok` and gives it its
  own bucket; `formatTable` renders a distinct `⚠` icon (`src/doctor/runner.ts:30`).
- The global crash handler (`src/cli/crash-handlers.ts`) is well-isolated for testability (exported
  function, not a top-level side effect, per its own doc comment) — but its *caller* has a real bug.
  See §Interactions-3.
- `judgeContradiction`'s `onFallback` callback (`src/consolidate/contradiction-judge.ts:77-93,
  110,119`) is the right shape: it doesn't change `FALLBACK_VERDICT`'s semantic meaning, it adds an
  out-of-band counter so `judge_errors` (migration 033 on this branch) can separate "judged and said
  unrelated" from "never actually judged." Correctly generalizes the `*_guard_drops` pattern per ADR-
  015 rule 1.

### #211/#206 — hang-watchdog — **SOUND**

- `DEFAULT_PROBE_TIMEOUT_MS = 10_000` and `DEFAULT_FAILURE_THRESHOLD = 2`
  (`src/service/watchdog-probe.ts:48,72`) are deliberately reasoned, not guessed: the doc comment at
  line 44-49 explicitly cites the 7.9s dashboard cold-render and argues 10s clears it with margin, and
  the 2-consecutive-failure doc comment (lines 55-72) argues correctly that a genuinely wedged daemon
  fails *every* subsequent probe (so requiring 2 costs only one extra interval of detection latency),
  while a merely-slow daemon essentially never fails twice in a row. This reasoning is sound *given
  #213 lands* — see §Interactions-2 for the one place it needs qualification.
  Failure count is persisted per-dataDir (`watchdog-probe.ts:129-160`) since each probe tick is a
  fresh process with no memory of the last tick — correct, and read/write failures degrade to "start
  from 0" (never a false-positive kill from a corrupt state file).
  `stopLockHolder`'s `!stopResult.ok` branch deliberately does *not* call `adapter.start()` and does
  *not* reset the failure counter (`watchdog-probe.ts:117-134`) — correct: claiming `'restarted'`
  when the hung process is still holding the port would be a false-positive recovery signal, and
  keeping the counter at threshold means the next tick retries the kill immediately rather than
  waiting through another full below-threshold run.

### #213 — dashboard refresh 5s→30s — **SOUND, but a mitigation, not the fix, and says so**

- `src/server/routes/dashboard-html.ts:440-458`. The change is one line (`content="5"` →
  `content="30"`), but the comment block above it independently derives and documents the *exact*
  restart-loop the lead flagged — down to naming `#206` and describing "dashboard open → stacked
  renders → /health slow → watchdog kills → restart → dashboard reconnects → repeat." This was not a
  miss; the author of #213 already knew about #211's watchdog and explicitly built #213 to defuse it.
  The comment also correctly self-labels this as removing "the amplifier," not the root cause
  ("stop doing aggregate scans on the hot path (own ticket)").
- One residual gap worth naming since the lead asked for what's *missed*: 30s only bounds the
  **single-viewer self-refresh** overlap case. It does not bound N *concurrent* dashboard viewers
  (each on their own 30s clock, unsynchronized) or a monitoring script polling `/dashboard` on its own
  cadence — with a 7.9s render, two independent viewers can still stack if their refresh phases drift
  within ~8s of each other, and better-sqlite3's synchronous nature means each stacked render fully
  blocks `/health` behind it regardless of how many viewers caused the pile-up. This is a smaller,
  lower-probability version of the same amplifier, not a new bug — flagging it because the underlying
  root cause (aggregate scans on the hot path) is explicitly deferred to a future ticket.

### fix-188 — schema_version content-hash — **SOUND in isolation, but does not protect against the failure it exists to prevent when two files share a version number simultaneously** (see §Interactions-1)

- The intent (`migrations/034-schema-version-content-hash.sql`) is exactly right for its stated
  target — a file being *renumbered or replaced after being applied* (the actual #185/#186 shape:
  migration once-numbered-030 got renumbered to 031, and a DB that had already recorded 30 against
  the old content broke). The backfill-then-verify split (`src/storage/migrate.ts:99-166`) is
  correctly conservative: first boot only ever backfills (every row is NULL going in), so the
  operator's 16,277-memory production DB cannot false-positive on its first post-upgrade boot — only
  from the *second* boot does verification start. This is a genuinely careful piece of engineering.
- **But `fileByVersion` (`migrate.ts:130-134`) is a `Map<number, string>` built by iterating `files`
  in lexical-sort order and calling `.set(version, f)` unconditionally** — the *last* file
  (lexically) to claim a given version number silently wins the map entry, with no uniqueness check
  and no error. If two files on disk both parse to version 33 *today*, this mechanism does not detect
  that at all; it just picks one. Whether that even gets a chance to run is moot in the collision
  scenario below, because the *original* apply loop (`migrate.ts:62-90`, pre-existing code, not
  touched by this PR) throws first — see §Interactions-1. Recommend: add an explicit duplicate-
  version check over `files` (throw immediately, "migrations M and N both claim version V") as part
  of this PR, since it is the PR whose entire purpose is protecting this exact invariant and it is
  the cheapest place to add it.

### fix-205 (atom `validity_extracted` canary), fix-207 (entity junk filter + canary), fix-200 (entity-link RATE canary) — **doctor-check bodies: SOUND on domain logic; UNSOUND on their own error handling** (see §Interactions-3, the most important finding in this review). **Migration numbering: currently colliding/in motion** (see §Interactions-1).

- All three canaries (`checkAtomValidityExtraction`, `checkEntityNameQuality`, `checkEntityLinkRate`)
  correctly implement ADR-015's rate-over-existence rule: they gate on `MEANINGFUL_USAGE_THRESHOLD`-
  style floors before computing a rate, they distinguish "not enough data" from "data present and the
  rate is bad," and `checkEntityLinkRate` in particular does real forensic work (windowing by a
  count-tail rather than calendar time, specifically to avoid the "straddled bucket" false alarm its
  own doc comment describes from issue #200's history, and cross-referencing `entity_link_drops`
  count to distinguish "model never emits" from "model emits, write fails"). This is the *pattern*
  ADR-015 asks for, correctly applied to the *domain* signal.
- All three, however, still write `catch (err) { return { ok: true, message: '... check error
  (non-fatal): ' + err }; }` with **no `inconclusive: true`, no `finally { db.close() }`** — the exact
  two defects #208 exists to fix, shipping fresh, the same day, in code whose own doc comments
  explicitly cite ADR-015 by name. See §Interactions-3 for file:line detail; this is not a minor nit,
  it is the review's headline correctness/consistency finding.

---

## Interactions

This is the section the lead asked to be weighted highest. Four findings, ordered by severity.

### 1. THE MIGRATION COLLISION IS NOT RESOLVED — IT IS ACTIVELY, PARTIALLY, AND INCONSISTENTLY BEING RESOLVED RIGHT NOW, ACROSS FOUR BRANCHES, WITH NO SHARED LEDGER

The lead's framing ("033/034/035/036, hand-assigned to four agents") does not match what is on disk.
Verified twice in this session, ~20 minutes apart, with different results both times:

**First read** (`git ls-tree`/`ls` across all four branches/worktrees):

| Branch | File | `SCHEMA_VERSION` |
|---|---|---|
| `fix/silent-error-swallowing` (#208) | `033-consolidation-judge-errors.sql` | 33 |
| `fix/200-entity-link-rate-canary` | `033-entity-link-drops.sql` | 33 |
| `fix205` worktree (uncommitted) | `033-atom-validity-extracted.sql` | 33 |
| `fix207` worktree (uncommitted) | `033-entity-name-drops.sql` | 33 |
| `fix/188-schema-version-hash` | `034-schema-version-content-hash.sql` | 34 |

Four files, four different branches, all independently claiming version **33**. This is the exact
shape of the incident fix-188 exists to prevent (`migrations/034-schema-version-content-hash.sql`'s
own header: "Two migrations were briefly both numbered 030... whichever applied first won and the
other was silently skipped (#185)") — except 4-way, not 2-way, and **fix-188 does not protect against
it** (see its verdict above): `src/storage/migrate.ts`'s pre-existing apply loop (lines 62-90, not
touched by #188) computes `applied` as a `Set` **once**, before the loop starts, from
`SELECT version FROM schema_version`. It is never updated mid-loop. So on a fresh DB (or any DB
where none of these four have yet applied), given all four `033-*.sql` files sorted lexically: the
first is applied and `INSERT INTO schema_version (version, ...) VALUES (33, ...)` succeeds; the
*second* file with the same parsed version number reaches the identical `INSERT ... VALUES (33,
...)` against a table where `version INTEGER PRIMARY KEY` — this throws a primary-key-constraint
violation, caught by the existing generic handler (`migrate.ts:75-89`) and re-thrown as `Migration
NNN failed to apply`. **`migrate()` throws. The daemon does not boot. This is not a degraded-start
case — `migrate()` is called before `serve.ts`'s degraded-start posture exists at all.** This would
hard-brick a fresh install, and — because `migrate()` runs unconditionally on every boot, not just
first-install — it would equally hard-brick the operator's own 16,277-memory production DB the moment
two of these branches both reach it, in either order, whether merged together or applied to prod
sequentially without a rebuild in between.

**Second read**, minutes later, in-session: two of the four branches had already moved.
`fix/200-entity-link-rate-canary` has since merged/rebased in #208's `033-consolidation-judge-errors`
and renumbered its own file to **`036-entity-link-drops.sql`** (`SCHEMA_VERSION = 36`).
`fix207`'s worktree has done the same and renumbered to **`034-entity-name-drops.sql`**
(`SCHEMA_VERSION = 34`) — which **now collides with fix-188's own `034-schema-version-content-hash.sql`**,
a collision that did not exist at the first read. `fix205`'s worktree has not moved at all — still
`033-atom-validity-extracted.sql`, `SCHEMA_VERSION = 33`, unaware that #208 also claims 33.

**Net assessment:** every individual agent is doing locally-reasonable de-confliction (pulling in
whichever sibling branch's migration they happen to know about and renumbering past it), but there is
no single shared ledger of "which number is claimed by whom," so each local fix has a real chance of
creating a new collision with a branch its author doesn't have visibility into — which is precisely
what just happened between `fix188` and `fix207`. **Recommend: before merging any of these four, the
lead (or one designated agent) freezes a single authoritative order and number assignment, communicated
to all four branches, and each branch rebases to match — not the reverse (agents discovering and
patching around each other ad hoc). Whatever the final numbers, add the uniqueness check recommended
in fix-188's verdict above as a permanent backstop, since this exact multi-agent-parallel shape will
recur.**

### 2. Watchdog (#211) × dashboard (#213): confirmed real, but already caught and mitigated by both authors — not a miss

Cross-checked the lead's own headline finding. `src/service/watchdog-probe.ts:44-49` (this session's
`fix/win-watchdog-hang-206` content) explicitly reasons about the 7.9s cold render and 10s timeout in
the same comment block that names `/dashboard`. `src/server/routes/dashboard-html.ts:440-455`
independently derives the identical restart-loop and names `#206` directly. **Both sides of this
interaction already reference each other by issue number in committed comments** — this was caught
by the builders, not missed, and #213 is the fix for exactly the amplifier the lead described. The
residual gap (concurrent-viewer stacking, not self-refresh stacking) is noted in #213's verdict above
and is smaller in probability than the one already fixed.

### 3. #208's own fix pattern was not propagated to the three canaries shipping the same day — the headline finding

`docs/adr/ADR-015-loud-failure-invariant.md`'s rule 2: *"A health check that computes a signal must be
able to return `ok: false` on it... `checkMemoryHealth` is the counterexample to fix, not the pattern
to follow."* `#208` builds the mechanism (`inconclusive`) and correctly retrofits it onto the checks
it audited (verified at `checkUsefulness`, `src/doctor/checks.ts:534-561` on that branch, and the hunk
list at `checks.ts` shows the same `let db` / `finally { db?.close() }` shape applied at
`checkSqliteWritable`, `checkBudget`, `checkRedaction`, `checkUsefulnessFeedbackLoop`,
`checkMemoryHealth`, `checkCrashLoop`, `checkEntityRelations`, `checkConsolidationJudgeTelemetry`,
`checkAutoCapture`, `checkProxyCapture`, `checkSchemaDrift`, plus the GPU check — the "9 doctor checks
+ 1 GPU check" the lead's scope names).

But three *new* checks landed the same day, in three different branches, each explicitly citing ADR-
015 in its own doc comment, and **none of them use the new mechanism**:

- `checkAtomValidityExtraction` (fix-205, `src/doctor/checks.ts:1375-1425` on that worktree): `const
  db = await openProductionDbReadonly(...)` **inside** the `try`, explicit `db.close()` calls on two
  success paths, and `catch (err) { return { ok: true, message: 'atom validity extraction check
  error (non-fatal): ' + err }; }` — no `inconclusive`, no `finally`. If the second query throws
  (after the first succeeded and `db` is open), **the DB handle leaks** — the exact class #208's own
  scope line ("Fixes a DB-handle leak surfaced by that") was written to close.
- `checkEntityNameQuality` (fix-207, `src/doctor/checks.ts:1391-1441` on that worktree): identical
  shape — `db` local to `try`, `db.close()` on success paths only, `catch (err) { return { ok: true,
  message: 'entity name quality check error (non-fatal): ' + err }; }`. Same leak, same silent-`ok`
  collapse.
- `checkEntityLinkRate` (fix-200, `src/doctor/checks.ts:1432-1495` on that branch): identical shape
  again — `catch (err) { return { ok: true, message: 'entity link rate check error (non-fatal): ' +
  err }; }`.

All three are, verbatim, the pre-#208 pattern this review's own scope says was already fixed
elsewhere in the same file, on the same day. This is not a hypothetical composition risk — it is
already true of the code on disk in three separate branches right now. Whichever merge order lands
these branches, unless someone deliberately reconciles this, **`doctor` will ship four brand-new "own
query threw" sites in one release, of which one (#208's own new `judge_errors` check, if it has one)
follows the new discipline and three do not** — precisely "three canaries have already made that
exact mistake today," confirmed with file:line evidence, and worth noting as a near-exact structural
echo of ADR-015's own header story about a stale citation silently out-living the fix that superseded
it. **Recommend: before merge, rewrite all three catch blocks to the `let db` / `finally` /
`inconclusive: true` shape #208 already established, using `checkUsefulness` as the template.**

### 4. #208's crash handler races its own documented carve-out

`src/cli/crash-handlers.ts`'s header states the global handler covers "every one-shot subcommand
**except `serve`, which installs its own daemon-appropriate crashExit in serve.ts**." The wiring in
`src/cli/index.ts` calls `installCliCrashHandlers()` unconditionally at module scope
(`src/cli/index.ts`, right after the imports, **before** `main()`'s `cmd` switch runs) — i.e. it
registers regardless of which subcommand is about to execute, including `serve`. `serve.ts`'s own
handler (verified in the current tree, not this branch's diff, since #208 doesn't touch `serve.ts`)
does real cleanup: `crashExit` there calls `lock?.release()` and `dbForCrash?.close()` before
`process.exit(1)`. Node invokes multiple listeners on the same event **in registration order**; the
generic handler is registered at import time, strictly before `serve.ts`'s own listener is registered
(which happens later, inside the async `serve()` command body). On an actual `uncaughtException` while
running as a daemon, **the generic listener fires first and calls `process.exit(1)` synchronously —
terminating the process before `serve.ts`'s own listener, registered second, ever runs.** The carve-
out the header describes does not actually happen; both listeners are installed, but the wrong one
wins.

Practical severity is lower than it sounds, not zero: `src/service/instance-lock.ts:46-57`'s
`pidAlive` check on the *next* start correctly detects the now-genuinely-dead PID and steals the
stale lock cleanly (`instance-lock.ts:135-137` inside `stopLockHolder`, and the symmetric branch in
`acquireInstanceLock`), so a skipped `lock.release()` self-heals on the next boot rather than
permanently wedging restart. The skipped `db.close()` is a lesser concern given SQLite's WAL-mode
crash tolerance, but it is still a correctness regression from the explicitly documented pre-existing
behavior ("log, release the lock, close the DB, exit 1" — `serve.ts`'s own comment). **Recommend:**
guard `installCliCrashHandlers()` on `cmd !== 'serve'` in `index.ts` (cheap, matches the header's
actual stated intent), or have it detect an already-registered daemon-specific handler and no-op.

---

## Crux: is #208's `inconclusive` tier "the same green light that lies" in new clothes?

Argued both ways, as asked.

**In its favor:** `formatJson`'s `summary.ok` correctly excludes inconclusive results, so any
*consumer that reads the JSON body* can tell "verified fine" from "we never verified" — that's a real,
inspectable distinction that did not exist before. The design note in `types.ts` is honest about the
tradeoff (doesn't hard-fail doctor's exit code, to avoid making a transient DB read error a hard CI
failure).

**Against it:** `hasFailures` in `src/cli/doctor.ts` (this branch) is `results.some(r => !r.ok)`, and
`inconclusive` deliberately never flips `ok`. So `doctor`'s **process exit code — the one channel that
is genuinely "readable without a human present" per ADR-015's own load-bearing phrase — is unchanged
whether every single check verified cleanly or nine of them silently failed to run at all.** Any
cron job, CI gate, or monitoring integration that does the standard thing ("run doctor, alert on
non-zero exit") is exactly as blind after this fix as before it. The human-readable table and the
JSON body both show the truth; the one consumer ADR-015 cares most about — the unattended one —
does not. This is the same observable-state collapse the ADR names, just moved one layer up the
stack, from the check's own boolean to the process's own exit code.

**Verdict: NEEDS-CHANGE, narrowly.** The mechanism is right; the boundary drawn around "what counts as
a failure for exit-code purposes" is the one place this PR reproduces the pattern it fixes everywhere
else. Recommend either a distinct exit code (e.g. 0 = all verified ok, 1 = hard failure present, 2 =
no hard failures but N inconclusive) or, at minimum, explicit documentation in the PR / CLAUDE.md that
existing exit-code-only automation must be updated to also check `summary.inconclusive` — as shipped,
that migration of downstream consumers is not called out anywhere in the diff.

---

## Summary table

| Change | Verdict |
|---|---|
| #208 silent-error audit (mechanism + retrofits) | SOUND |
| #208 crash handler wiring | NEEDS-CHANGE (§Interactions-4) |
| #208 `inconclusive` exit-code semantics | NEEDS-CHANGE (§Crux) |
| #211/#206 hang-watchdog | SOUND |
| #213 dashboard refresh | SOUND (mitigation, correctly labeled as such) |
| fix-188 schema-version content-hash | SOUND in isolation; NEEDS-CHANGE — add duplicate-version detection (§fix-188 verdict, §Interactions-1) |
| fix-205 atom-validity canary (domain logic) | SOUND |
| fix-205 error handling | UNSOUND (§Interactions-3) |
| fix-207 entity-quality canary (domain logic) | SOUND |
| fix-207 error handling | UNSOUND (§Interactions-3) |
| fix-200 entity-link-rate canary (domain logic) | SOUND |
| fix-200 error handling | UNSOUND (§Interactions-3) |
| Migration numbering across all four in-flight branches | UNSOUND as of this review — actively colliding, moving during the review itself (§Interactions-1) |
