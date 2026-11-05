# Handoff: SLICE-443 (FEAT-553) — DEC-017 trust policy for string-derived project identity

- **Objective**: write the ADR-style decision record (`DEC-017`) that fixes
  the trust policy for string-derived `project`/`repo` identity when `git`
  cannot answer (the worktree has already been deleted) — the decision that
  SLICE-444 (ingest hardening) and SLICE-445 (backfill extension) implement
  against. Per the slice file, this is a **decision-record-only** slice:
  "Any source or test change" is explicitly out of scope.
- **Owner**: builder (this dispatch, wave 1)
- **Worktree**: `C:\work\mega\astramem-local-SLICE-443-0`
- **Branch**: `main-SLICE-443`
- **Base**: `main` @ `02cf8ede`

## Allowed scope (per slice `touches_files`)

- `.claude/artifacts/loop/decisions/DEC-017.md`
- `.claude/artifacts/loop/decisions/README.md`

## Forbidden scope

- Any `src/` or `tests/` change — this slice is a decision record only;
  SLICE-444 and SLICE-445 implement the policy decided here.

## Deliverable — files changed

New:
- `.claude/artifacts/loop/decisions/DEC-017.md` — frontmatter copied from
  `DEC-016.md`'s shape (`id`, `created`, `status: active`, `decided_by`,
  `relates: FEAT-553, FEAT-484, FEAT-425`) per the slice's explicit
  instruction. Body decides the four points the slice's In-scope section
  lists verbatim:
  1. String-derived identity is TRUSTED only for the two tool-generated
     layouts `<repo>/.claude/worktrees/<x>` and `<repo>-worktrees/<x>`;
     every other unresolvable shape stays `unresolved` (FEAT-484 never-guess
     guard preserved, not loosened).
  2. Ingest overrides a client-sent `project_id` only when it equals
     `basename(cwd)` (the hook-produced shape); an explicit different label
     is stored verbatim (FEAT-553 AC-5).
  3. Every override/re-stamp is observable via a structured log event
     carrying original value, derived value, and
     `source: 'git-common-dir' | 'string-heuristic'` (AC-7); any path in
     that event or in backfill preview output is a repo-root basename,
     never an absolute path (AC-9).
  4. `repo` gets the same string fallback as `project` when git is
     unresolvable (closes the half of FEAT-484 that left those rows
     `unresolved`).

Unchanged (verified, not touched):
- `.claude/artifacts/loop/decisions/README.md` — read in full. It documents
  the decision lifecycle/creation flow and inspection commands but carries
  **no per-DEC index list** (confirmed: `grep -c "DEC-0" README.md` → 0
  matches before this change). The slice's own instruction is conditional —
  "Add the DEC-017 line to README.md **if that file carries an index**" —
  and it does not, so no edit was made. (The only other place `DEC-016` is
  referenced is the generated `.claude/artifacts/loop/loop-snapshot.md`,
  which is not in this slice's `touches_files` allowlist and was left
  alone.)

## Side effect found and reverted (not committed)

Running the full `bun run test` suite (see Evidence) mutates a checked-in
eval-results snapshot as a pre-existing side effect of
`tests/eval/consolidation-eval.test.ts` (or an adjacent suite) rewriting
`scripts/eval/consolidation-bench/results/latest-run.json`'s `generatedAt`
timestamp. This is unrelated to the DEC-017 change, outside this slice's
`touches_files` allowlist, and was reverted with `git checkout --
scripts/eval/consolidation-bench/results/latest-run.json` before commit so
the tree only carries the intended decision-record diff. Worth a follow-up
note (not filed as a new FEAT by this slice — out of scope): the full-suite
gate is not idempotent on a clean tree.

## Evidence

- `bun install` — 297 packages, clean (fresh `node_modules`, not shared
  with the main checkout per the dispatch's HARD RULE).
- `bun run build` (`tsc -p .`) — clean, no output.
- `node contracts/validate.mjs` — 58/58 fixture checks pass.
- `bun run test` (`vitest run`, the full `.claude/loop.json` `stack.test[0]`
  command) — see the validation artifact for the full result; run against
  this worktree's unmodified `src`/`tests` tree (no source or test file was
  touched by this slice) so its outcome reflects baseline `main` health,
  not a risk introduced by `DEC-017.md`.

## AC checklist

- **AC-S1** (in-scope deliverable exists as described, nothing out-of-scope
  touched): PASS — `DEC-017.md` written matching the four decision points
  and the DEC-016 frontmatter shape the slice names explicitly;
  `README.md` left unmodified because it carries no index (the slice's own
  conditional); no `src/`/`tests/` file touched.

## Risks / follow-ups

- SLICE-444/445 should cite `DEC-017` directly rather than re-deriving the
  trust boundary — flagged in the decision's own "How to apply" section.
- The full-suite non-idempotent side effect (eval-results timestamp churn)
  noted above is pre-existing repo behavior, not introduced by this slice;
  worth a backlog follow-up but not blocking this decision-record slice.
