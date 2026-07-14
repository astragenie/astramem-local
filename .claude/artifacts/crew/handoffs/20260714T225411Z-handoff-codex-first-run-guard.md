# Handoff — codex first-run onboarding guard

- **Objective**: close the deferred nice-to-have from the architect review
  (`.claude/artifacts/crew/reviews/20260714T130000Z-architect-review-release-readiness-stabilization-plan.md`,
  answer 6) — detect "codex-subscription selected AND no `codex login` present"
  before the first extraction attempt, since a fresh install on the shipped
  default silently accumulates below-threshold poisons that the periodic
  doctor check doesn't catch until its 24h full-tier piggyback runs.
- **Owner**: crew:fullstack-dev (this dispatch)
- **Branch**: `feat/codex-first-run-guard` (off `origin/main` @ `a70cad7`), 1 commit (`999590b`), no push, no PR.
- **Allowed scope**: providers/doctor/serve/init. **Forbidden**: `defaultConfig()` default, contradiction-detection config, files outside that scope. Both honored — diff touches only `src/providers/llm/codex-subscription.ts`, `src/cli/init.ts`, `src/cli/serve.ts`, and their two test files.

## What was already built (verified, not re-built)

The doctor check itself — a FAIL row naming `codex login` when codex-subscription
is selected and `~/.codex/auth.json` is missing — **already existed**:
`checkCodexAuth` / `codexAuthProbe` (`src/doctor/checks/provider-supplementary.ts`,
`src/doctor/probes/codex-subscription-probe.ts`), registered conditionally in
`src/doctor/checks/index.ts` whenever the live provider instance is
`CodexSubscriptionLLMProvider`. No changes needed there. The real remaining gap,
confirmed by code reading, was that this check only runs on the 24h full-tier
doctor piggyback (per CLAUDE.md's doctor-scheduling notes) — nothing fired at
boot, and the non-interactive init path had no equivalent gate at all (unlike
the interactive wizard's `codexLoginDetected` prompt gate).

## What changed

1. **`src/providers/llm/codex-subscription.ts`** — exported the previously
   private `defaultAuthPath()`, and added `hasCodexLogin(authPath?)`: a
   presence-only `existsSync` check, the one shared "is codex logged in"
   helper now reused by init.ts, the new serve.ts boot guard, and (already)
   the doctor probe's deeper validation.
2. **`src/cli/init.ts`** — removed the duplicate local `defaultCodexAuthPath()`
   (same `join(homedir(), '.codex', 'auth.json')` expression, now imported
   from the provider module). Added a non-blocking `console.warn` in
   `gatherNonInteractive()` when `llmProvider === 'codex-subscription'` and
   `hasCodexLogin()` is false — the non-TTY path previously always wrote the
   shipped default regardless of login state, with zero signal.
3. **`src/cli/serve.ts`** — added a boot-time check right where
   `codexSubscriptionInUse` is already computed (used by the existing doctor
   opts wiring): if in use and not mock-provider mode, dynamically import the
   helper and check `cfg.codexSubscription.authPath ?? defaultAuthPath()`
   (the exact path `providers/index.ts` feeds the real provider). Logs a loud
   `console.warn` naming `codex login` and the `ollama`/`qwen2.5:7b`
   config alternative. Does **not** auto-rewrite config.yaml — matches the
   architect review's explicit instruction; interactive steering remains the
   wizard's job.

## Evidence

```
bun run build                                    -> clean (tsc -p ., no errors)
bunx vitest run tests/providers/codex-subscription-llm.test.ts   -> 32 passed | 1 skipped
bunx vitest run tests/cli/init.test.ts                            -> 24 passed
bunx vitest run tests/doctor/ tests/providers/codex-model-drift.test.ts tests/capture/codex.test.ts
                                                   -> 44 files / 335 tests passed
```

New tests added:
- `hasCodexLogin` / `defaultAuthPath` unit coverage (4 cases: path shape,
  missing file, present-but-malformed file [presence-only, not validated],
  real well-formed auth.json) in `tests/providers/codex-subscription-llm.test.ts`.
- Two `init.ts` non-interactive tests: warns (non-blocking, config still
  written) when codex-subscription selected with no login; does not warn
  when a login file is present.

## Confidence

High on the shared-helper extraction and the two new call sites (both
narrow, additive, covered by tests). Medium on the boot-guard's real-world
value versus the doctor check's existing coverage — this closes a genuine
same-day gap (24h piggyback cadence vs. immediate boot) but the two
mechanisms now say the same thing twice by design (doctor: FAIL row;
serve: WARNING log line), which is intentional per the architect review's
framing ("closing canaries... but closing the wrong two" was the actual
prior risk — this is the *right* one, additive to a boot path with no
prior canary at all).

## Risks / open items

- **No in-process test exercises the `serve.ts` boot warning directly.**
  This repo has no existing pattern for in-process `serve()` unit tests —
  every serve.ts behavior is currently covered only via spawned-subprocess
  smoke tests (`tests/smoke/`), which are heavy (full daemon boot: db,
  migrations, instance lock). Building that harness from scratch was out of
  proportion for this slice. The guard's actual decision logic (`hasCodexLogin`)
  is fully unit-tested; the serve.ts wiring is a thin, directly-inspectable
  `if` + `console.warn` reusing that tested helper — low residual risk, but
  flagging the coverage gap explicitly rather than papering over it.
- **HealthState was deliberately NOT extended** with a generic
  "degraded-reason" field. The dispatch prompt's guidance was conditional
  ("if the pattern exists") — `HealthState.status()` today is strictly
  embed-driven (`starting`/`ok`/`degraded` off `embed.ok`), and bolting on
  an unrelated reason without redesigning that contract risked scope creep
  into `/health` route consumers and their tests. If surfacing this at
  `/health` (not just the log) becomes a real ask, that's a follow-up FEAT,
  not a silent extension here.
- **Branch state note**: this dispatch's `feat/codex-first-run-guard` branch
  was briefly (and mistakenly) checked out in the shared main checkout
  (`C:/work/mega/astramemory-local`, not this isolated worktree) before the
  error was caught and the main checkout was restored to `main`. No commits
  were made there; the branch's only commit lives in this worktree
  (`agent-af7728302db1e01dc`). Confirmed via `git worktree list` that no
  other agent had that branch checked out at the time.

## Suggested next handoff

`crew:reviewer` for an independent pass on the diff (5 files, ~186 lines),
then `crew:validator` if the guard's boot-time console output should be
smoke-verified against a real daemon boot with a deliberately-missing
`~/.codex/auth.json` (would need a temp `HOME`/`APPDATA` override — the
existing `tests/smoke/` harness pattern is the closest fit).
