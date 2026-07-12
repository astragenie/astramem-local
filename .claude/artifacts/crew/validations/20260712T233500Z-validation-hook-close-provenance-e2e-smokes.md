---
type: validation
created: 2026-07-12T23:35:00Z
run: hook-close-provenance + e2e smokes (interactive session e08b8f83)
result: PASS
validator: lead (evidence aggregated from builder + reviewer runs + live daemon probe)
---

# Validation — hook_close provenance fix + auto-capture/profile e2e smokes

## Scope validated

1. `capture claude` (no `--auto-capture`) stamps `capture_source = 'hook_close'`;
   doctor "Auto-capture" canary counts `IN ('auto_capture','hook_close')`.
2. New e2e: `tests/e2e/auto-capture-close.e2e.test.ts` — real CLI → spool →
   fixture deleted (race-fix proof) → boot drain → distill → memory rows all
   `hook_close` → doctor check ok:true.
3. New e2e: `tests/e2e/profile-learning.e2e.test.ts` — mistake → supersede →
   search excludes superseded / returns correction → 5× submit_feedback moves
   rank 4th→1st via epsilon → agent_profile.corrections[] + top_lessons →
   user_profile.recurring_lessons → invalidate negative case.

## Evidence

- Builder full suite: 218 test files / 2630 tests passed, 0 failures (6 pre-existing skips).
- Reviewer independent run (post `bun run build`): 7 files / 66 tests passed;
  verbose re-run confirmed both new e2e files actually execute (1125ms / 254ms).
- Lead re-run after typecheck fixups: `tests/cli/capture-claude.test.ts` +
  `tests/e2e/` → 5 files / 21 tests passed.
- Live production probe (same session, pre-fix→post-fix): stale global CLI 0.3.4
  upgraded to 0.15.0; `capture claude` on a real session transcript spooled to
  `ingest-spool/` and drained by the live daemon (memory count 12509→12510).
- Review artifact: `.claude/artifacts/crew/reviews/20260712T233000Z-review-result-hook-close-provenance-profile-learning.md` — PASS, no findings.

## Known residual risk (process, not code)

Version skew: a 0.14.0 daemon's spool-drain rejects `hook_close` envelopes
(closed zod enum predates widening) — quarantined after 5 drain attempts, not
silently dropped. Mitigation: run `reinstall` (serve 0.15.0+) before/with any
npm publish that ships the new CLI to this box or users.
