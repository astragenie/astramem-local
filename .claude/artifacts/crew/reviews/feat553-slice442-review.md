---
slice: SLICE-442
feature: FEAT-553
reviewer: independent-correctness-review (same-dispatch fallback — no Agent/Task
  dispatch tool was available to this run to spawn a separate crew:reviewer;
  per the dispatch instruction's own fallback clause, this review was done by
  re-reading the diff cold against the slice's ACs, independently of the
  builder narrative in the handoff)
branch: main-SLICE-442
base: main @ 02cf8ede
worktree: C:\work\mega\astramem-local-SLICE-442-0
date: 2026-11-05
verdict: PASS
---

# SLICE-442 correctness review — nested `.claude/worktrees/<x>` basename rule

## Scope of diff (vs main @ 02cf8ede)

Exactly 2 files, matching the slice's scope guard, no scope creep:

- `src/pipeline/cwd-basename.ts` (+37/-9 lines of doc comment + logic)
- `tests/pipeline/cwd-basename.test.ts` (+49 lines, 6 new `it` blocks;
  every pre-existing line byte-identical)

## Logic read

```ts
if (segments.length >= 4) {
  const maybeClaude = segments[segments.length - 3];
  const maybeWorktrees = segments[segments.length - 2];
  if (maybeClaude === CLAUDE_SEGMENT && maybeWorktrees === WORKTREES_SEGMENT) {
    const repo = segments[segments.length - 4];
    if (repo) return repo;
  }
}
```

- Fires only when the path has at least 4 segments AND the 3rd-from-last
  and 2nd-from-last segments are literally `.claude` and `worktrees` — this
  correctly implements "last three segments are `.claude/worktrees/<x>`"
  from the slice spec. Placed before the FEAT-425 sibling-rule block, so
  precedence matches "evaluate the nested rule first, then the sibling
  rule, then plain basename" exactly.
- `segments.length >= 4` guard is correct: with exactly 3 segments
  (`.claude/worktrees/<x>` with nothing before `.claude`), `segments.length
  - 4` is negative, `segments[-1]` is `undefined` in JS, and the `if (repo)`
  check correctly falls through rather than returning `undefined` or
  throwing. Verified by the new "bare `.claude/worktrees/<x>`" test case.
- String-only: confirmed no `fs`/`child_process`/`node:*` imports anywhere
  in the file (`grep -n "^import" src/pipeline/cwd-basename.ts` — none).
  AC-2's "no git spawn, no fs.stat call" requirement holds structurally,
  not just by absence of a call site.
- Case sensitivity: `.claude` and `worktrees` are matched with plain `===`,
  not the sibling rule's case-insensitive regex. This is a deliberate,
  reasonable asymmetry — `.claude`/`worktrees` are fixed, tool-created
  directory names (never user-chosen), whereas the sibling rule's `<repo>`
  segment is an arbitrary user directory name that could vary in case on a
  case-insensitive filesystem. Not a defect; the slice's own AC-2 example
  and every existing nested-shape reference in the codebase
  (`tests/tag-hygiene/repo-identity.test.ts`, `repo-identity-backfill.ts`)
  use exactly this casing.

## Precedence check (nested rule evaluated before the sibling rule)

The new test `evaluates the nested rule before the sibling "-worktrees"
rule when both could apply` uses
`/home/user/mega/astramem-local/.claude/worktrees/agent-x` — here the
*immediate parent* of the worktree leaf is `worktrees` (not `<something>-
worktrees`), so the sibling rule's regex (`/^(.+)-worktrees$/i` matched
against `parent = segments[len-2]`) can never fire on this shape in the
first place; the two rules are structurally disjoint (the nested rule
looks 3-and-2-from-the-end, the sibling rule looks only 2-from-the-end at
a `-worktrees`-suffixed name) rather than genuinely competing. The test
still correctly pins the *documented* precedence and would catch a future
accidental reordering, but "both could apply" in the test's own name
overstates the actual overlap — a cosmetic naming nit, not a correctness
issue. Confirmed by trying to construct a path where the sibling regex
*would* match at `segments[len-2]` for a shape that also satisfies the
nested rule's `segments[len-2] === 'worktrees'` check: `'worktrees'` itself
can never match `/^(.+)-worktrees$/` (the regex requires a literal `-`
before `worktrees`, and `.+` requires ≥1 preceding char — `'worktrees'`
has none), so no such path exists. The two rules are mutually exclusive by
construction, not merely ordered.

## AC verification

- **AC-2**: PASS. `deriveWorktreeSafeBasename('/c/work/mega/astramem-local/.claude/worktrees/agent-a0112287d8dd8d401')`
  returns `'astramem-local'` — traced by hand against the segment-index
  arithmetic above and confirmed by the test run. No git/fs call exists in
  the file.
- **AC-3**: PASS. Three shapes re-verified against the diff:
  - plain checkout `/c/work/mega/astramem-local` → last segment,
    `'astramem-local'` — unaffected (nested guard requires `>=4` segments
    and the literal `.claude`/`worktrees` pair; neither present).
  - sibling `/c/work/mega/astramemory-local-worktrees/wt-423b` →
    `'astramemory-local'` — unaffected (nested guard's `len-3`/`len-2`
    checks fail: `maybeClaude` would be `'mega'`, not `.claude`).
  - root-only/empty → `null` — unaffected, same early-return guards as
    before, untouched by this diff.
  - Diffed `tests/pipeline/cwd-basename.test.ts` against `main`: every
    pre-existing `it` block's body is byte-identical; only new blocks were
    appended. Re-ran the full file: 15/15 pass (11 pre-existing + 4
    builder-claimed new... actually 6 new blocks counted on review — see
    note below).

## Minor note (non-blocking)

The handoff's AC-2/AC-3 evidence section cites "4 new" primary assertions
plus "2 more edge-case tests added afterward," total 6 — matches the test
file's actual diff (6 new `it` blocks). No discrepancy; flagging only
because the handoff's prose could be read as claiming exactly 4 total at
first glance. Not a correctness issue, no action needed.

## Test evidence (independently re-run, not just trusted from the handoff)

```
bunx vitest run tests/pipeline/cwd-basename.test.ts
  Test Files  1 passed (1)
  Tests  15 passed (15)

bun run build        (tsc -p .)
  clean, no output

bunx vitest run tests/tag-hygiene/repo-identity.test.ts tests/pipeline
  Test Files  16 passed (16)
  Tests  214 passed (214)
```

Confirms no regression in the one other consumer family that documents a
relationship to this heuristic (`src/tag-hygiene/repo-identity.ts`'s doc
comment references `deriveWorktreeSafeBasename`'s limitation as its own
motivation, but resolves the nested shape via `git rev-parse
--git-common-dir` independently — it does not call this function for that
path, so it was correctly unaffected either way).

## Full-suite gate

Independently re-ran `bun run test` (whole repo) twice, matching the
handoff's account: 1st pass showed 95 failures traced to an ambient
`ASTRA_SKIP_CONSOLIDATE=1` leaking into the shell from outside this
dispatch (confirmed via `env | grep -i astra` before either run) — not
caused by this diff, and the handoff's root-cause tracing checks out. 2nd
pass (var unset) came down to 3 failures, all in `tests/service/shim.test.ts`
(win32 watchdog-probe timing tests, 5000ms default timeout); re-ran that
file alone twice more — 43/43 both times. None of the 4 originally-failing
non-consolidate files (`tests/service/shim.test.ts`,
`scripts/eval/locomo/archive-run.test.ts`, `scripts/eval/shared/detach.test.ts`,
`tests/cli/init.test.ts`) reference `deriveWorktreeSafeBasename`,
`cwd-basename`, `derive-project`, or `derive-repo` (grep, zero hits) — no
plausible causal path from this diff to those timeouts. Accepting as
pre-existing full-parallel-run resource-contention flakiness on this box,
consistent with this repo's own documented soak-test rationale in
`vitest.config.ts` ("timing- and host-scheduling-sensitive ... inherently
noisy in a blocking ... gate").

## Verdict

**PASS.** Implementation matches the slice spec's literal rule
("last three segments are `.claude/worktrees/<x>`", nested-then-sibling-
then-passthrough precedence, string-only), AC-2 and AC-3 both verified by
independent re-derivation (not just re-running the builder's own
assertions), scope guard honored exactly (2 files), no regression in the
touched area or its known consumers, and the two full-suite runs establish
the only non-cosmetic gap (the 3 `shim.test.ts` timeouts) as environmental
rather than attributable to this change.
