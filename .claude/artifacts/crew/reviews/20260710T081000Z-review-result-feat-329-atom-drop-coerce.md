# Review result — fix(distill): coerce unknown entity kind → 'other' (FEAT-329, PR #152)

- **Verdict:** PASS (post-merge review — PR #152 was merged to main by the
  product owner before the review gate completed; this artifact records the
  retroactive verification)
- **Reviewed:** commit 1594165 (branch fix/FEAT-329-atom-drop-coerce) vs main;
  merged as 1db33ba (#152)
- **Reviewer:** crew:reviewer-lite (session 06ffd9f6, 2026-07-10)

## Findings

1. Bug confirmed real on main HEAD pre-merge: `05-extract.ts` tryParseAtoms
   filtered whole atoms through `AtomSchema.safeParse` with no entity-kind
   pre-normalization — one out-of-enum `entities[].kind` silently dropped the
   entire atom (aggravated by atom@2's stricter 12-kind enum). File untouched
   by FEAT-453/455 (blob-hash verified).
2. Fix scope minimal: `coerceEntityKinds` rewrites only `entity.kind` to
   `'other'` (a legal ENTITY_KINDS member), mirrors cloud
   `EntityKinds.Normalize()`; non-entity atoms pass through unchanged.
3. Tests included: coercion assert, mixed-array partial-coercion assert, and a
   regression guard that non-kind validation failures still drop the atom
   (no overcorrection into leniency). 16/16 pass in isolation; tsc clean.
4. Merge-tree clean vs main; verified in a throwaway worktree without touching
   the main checkout.

No blocking findings. Provenance note: commit was authored by an unattributed
local-machine agent session and merged by the owner (shishkosv) as #152 before
review completed; correctness independently confirmed here.
