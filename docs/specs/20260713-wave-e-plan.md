# Wave E — quick wins + must-haves discovered 2026-07-13

*Derived from the day's findings, not from the original teardown. Everything here is a bug or an enforcement gap that was found while fixing something else.*

**Governing ADRs:** `ADR-015` (loud failure) and `ADR-016` (the Junction Invariant). Wave E is the first plan written *after* ADR-016, so it applies ADR-016 to itself — see "The junction in this plan" below.

---

## Three hard constraints (unchanged from the stability plan, plus one new)

### 1. NO OLLAMA. The GPU is taken.
A **full-sample LoCoMo run is live** (PID 167340, worktree `astramemory-local-wt-locomo-postfix`, run-dir `20260713-codex-qwen`). Its compaction stage uses `qwen3:8b`. Ollama is at **6.8GB / 8GB**.

Earlier today four concurrent LLM consumers took embed latency from **37ms → 48s and poisoned 24 production distill jobs.** **Every Wave E slice runs `ASTRA_MEMORY_MOCK_PROVIDERS=1`. No exceptions.** Nothing in Wave E needs a model.

### 2. NO WORKTREE TOUCHES THE PRODUCTION DATADIR
Default datadir **is production** (17,654 real memories). Every worktree exports:
```bash
export ASTRA_MEMORY_ISOLATED=1
export ASTRA_MEMORY_MOCK_PROVIDERS=1
export ASTRA_MEMORY_DATADIR="$PWD/.dev-datadir"
export ASTRA_MEMORY_TOKEN=devtok
```
`ASTRA_ALLOW_PROD_DATADIR=1` is **forbidden**. Read-only probes against prod are permitted **only** via `openProductionDbReadonly` (`readonly: true`), never `migrate()`.

**Do not set `ASTRA_MEMORY_ISOLATED=1` when running the full test suite** — several tests assert behaviour *when the flag is unset*, and exporting it globally fails them. The suite gate is exactly what CI runs: `bun run test -- --testTimeout=60000`, **no env vars**.

### 3. THE JUNCTION IN THIS PLAN — read before dispatching

**`src/doctor/checks.ts` is a junction, and PR #231 is rewriting it into 35 files right now.**

Three Wave E items naturally land in it (E1's canary, E4, E7). If they run in parallel with #231 they will all collide, and the natural conflict resolution ("keep my version, the split is the point") **silently deletes canaries** — that exact near-miss happened today.

So Wave E is cut into **two lanes**:
- **Lane 2 (parallel, now)** — everything file-disjoint from `src/doctor/checks*`.
- **Lane 1 (serial, after #231 merges)** — everything that touches a doctor check.

**Only ONE Wave E slice may mint a migration number (E1 → `041`).** Ground-truth it with `git ls-tree origin/main -- migrations/` immediately before committing. `SCHEMA_VERSION` is now derived (#229 + #233), so a migration PR touches **only its own `.sql` file** — if you find yourself editing a version number anywhere else, stop and report.

---

## LANE 2 — parallel, dispatch immediately, file-disjoint

| Slice | Owns (exclusive) | Why |
|---|---|---|
| **E1a** — vec-upsert silent failure (#209) | `src/storage/memories.ts`, `migrations/041-*.sql` | **Data loss, in production, right now** |
| **E2** — capability detection, not a name regex | `src/providers/llm/ollama.ts` | `deepseek-r1` reproduces the "fixed" incident exactly |
| **E3** — `typecheck:tests` in CI (#235) | `.github/workflows/lint.yml`, ~10 test files | Every type-level guarantee in `tests/` is currently decoration |
| **E5** — schema-literal hygiene test | `tests/hygiene/schema-version-literals.test.ts` (new) | ADR-016 §6's own admitted gap |
| **E6** — `--ours` rebase footgun | `CLAUDE.md` | Two lines. Silently reverted six files today. |
| **E8** — `restore --force` | `src/cli/restore.ts` | A recovery tool that refuses to run in a degraded environment |
| **E9** — close stale issues | *(no files — `gh` only)* | Real bugs are hidden behind fixed ones |

### E1a — #209: a failed vec-upsert returns `ok:true` and is never retried
> *"13 production memories are INVISIBLE to vector search, permanently."*

**This is the highest-priority item in the plan.** It is the ADR-015 disease in the **data path**, not the observability path: memories that exist, that the user believes are stored, that **can never be recalled**. The write reports success. Nothing retries. Nothing tells anyone.

- **First, measure it against production, read-only.** Count active memories with no corresponding `memories_vec` row. The issue says 13; **verify, do not trust the number** — it is days old. (`openProductionDbReadonly` + `sqlite-vec` extension must be loaded, or the `vec0` module is unavailable.)
- The insert path must **not** report success when the vector index write failed. **Loud, or durable, or both** — pick deliberately and argue it.
- **A retry is the real fix, not just an alarm.** An alarm on unrecallable data still leaves the data unrecallable. Migration `041` should give the row a durable "needs vec index" state that a background pass can drain.
- **Backfill the existing orphans.** Whatever the live count is, those memories are unrecallable today. Fixing the write path does not heal them.
- Canary → **Lane 1** (it belongs in `src/doctor/checks/`). Do not add it here.

### E2 — the qwen3 `think:false` guard is a name regex, not capability detection
`src/providers/llm/ollama.ts` guards with `/^qwen3/i`. **The config field's own doc comment names `deepseek-r1` as having the identical thinking-mode / `format:json` conflict — and it is not handled.** A user who picks `deepseek-r1` reproduces the incident this guard was written to fix.

Detect the **capability**, not the **name**. If a true capability probe isn't available, at minimum make the model list explicit, data-driven, and **loud when it meets an unknown model that behaves like a thinking model** — a silent wrong answer is the failure mode here (qwen3 returned *empty* under `format:json`, which is indistinguishable from "nothing to extract").

### E3 — #235: `typecheck:tests` has never run in CI
`lint.yml`'s typecheck job covers `src/**` only. **Nothing type-checks `tests/**` on any push, ever.** So every `@ts-expect-error` proof and type-level fixture is decoration — and we already shipped a comment claiming CI enforced one (corrected in #232).

1. Fix the ~10 pre-existing errors (re-derive the list; it may have drifted).
2. Wire `bun run typecheck:tests` into `lint.yml` as a required job.
3. **Prove it: break a type in a test file and watch CI fail.** Do not assert that the job exists.

### E5 — the hygiene test ADR-016 admits is missing
#233 proved "zero hardcoded schema-version literals" **by hand**, and **nothing keeps it true.** One test: scan `tests/**` and `src/**` for a bare schema-version literal; fail with the offending file:line. This becomes the **second enforced rule in the codebase** — ADR-016 §6 currently says there is exactly one.

### E6 — the `--ours` footgun (two lines in `CLAUDE.md`)
> During a `git rebase`, `--ours` is the **upstream** side, **not** your commits — the inverse of a normal merge.

It silently reverted six files in #229, and **the suite stayed green because the literal happened to equal the derived value.** Read the conflict markers; never pick a side by name.

### E8 — `restore --force`
`restore` now aborts on any `!stopResult.ok` (#224) — correct, since it is about to rename the live DB out from under an unidentified lock holder. But on a box where PowerShell/CIM is unavailable, an operator who has **manually verified it is safe** must delete `daemon.lock` by hand. Add an explicit, loudly-warned `--force`.

### E9 — close what today actually fixed
These look resolved by merged work but are still open, and they bury the live ones: **#188** (→ #212), **#205** (→ #216), **#206** (→ #211), **#207** (→ #218/#219), **#190** (→ #196), **#187** (→ #194).
**Verify each against `origin/main` before closing.** A wrongly-closed issue is worse than an open one.

---

## LANE 1 — serial, AFTER #231 merges (they all touch a doctor check)

| Slice | Owns |
|---|---|
| **E1b** — vec-orphan canary | `src/doctor/checks/vec-index.ts` (new) + one `index.ts` line |
| **E4** — #217: `checkAutoCapture` gates on an all-time count, not a recency window | `src/doctor/checks/auto-capture.ts` |
| **E7** — #220: generalise the no-`ok:true`-in-`catch` lint | `tests/doctor/catch-must-not-report-healthy.test.ts` |

**E4 is the third instance of a pattern we fixed twice today** (#200, #190): a canary whose denominator is *all time*, so it goes green forever once enough historical successes accumulate. **State the denominator over a recency window** (ADR-015 rule 6).

**E7**: #221 shipped a build-fail guard for exactly one case. Generalise it, and note the same shape now exists across 35 split files — the guard must scan `src/doctor/checks/**`, not one file.

---

## Dispatch

```
NOW:   E1a ∥ E2 ∥ E3 ∥ E5 ∥ E6 ∥ E8 ∥ E9      (7 worktrees, mock providers, zero GPU)
       #231 ∥ #239                              (already in flight)
                 ↓ #231 merges
THEN:  E1b → E4 → E7                            (serial, doctor-checks lane)
```

**Every PR: draft + `hold` label on creation.** `.github/workflows/auto-merge.yml` squash-merges any green non-draft PR with **no review click** — it shipped an incomplete security fix today.

**Every PR: verify against the ref you PUSHED.** `git status --short` and `git diff origin/<branch> HEAD` must both be empty before reporting. **Three PRs today shipped a "verified" state that was never committed** — a green local check against a state that wasn't what shipped.

**Every PR gets a reviewer before the `hold` comes off.** Thirteen reviews ran today; **every single one found something real**, including three that found bugs in the instructions I gave.
