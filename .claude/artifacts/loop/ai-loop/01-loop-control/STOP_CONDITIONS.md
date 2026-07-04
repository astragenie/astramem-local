# Stop Conditions

The autonomous loop halts only when one of the triggers below fires. `loop.marathonMode` in `.claude/loop.json` (default `true` for new installs — "auto mode" in docs) controls whether the two soft triggers (iteration cap, crew `blocked` badge) are gating or advisory.

| Trigger | auto mode (default) | legacy (marathonMode=false) |
|---|---|---|
| Backlog exhausted | halt | halt |
| Crew `escalated_to_human` | halt | halt |
| Warn-severity pattern alert | halt | halt |
| High-severity cost alert | halt | halt |
| Iteration cap (default 25) | advisory | halt |
| Crew soft `blocked` badge | advisory | halt |

Auto mode never disables telemetry — `stop-check` still reports `iterationCount`, `iterationCap`, and `crewBlocked` in the `snapshot` block. Set `marathonMode: false` to restore bounded-iteration behavior.

## Allowed stop condition A — complete

ALL gate sets defined in `.claude/artifacts/loop/ai-loop/02-acceptance-gates/` are PASS.

Until the per-area gate files exist with > 3 testable criteria each, condition
A is unreachable and the loop stops only on condition B or on user
intervention. Author gate files for each product area as the implementation
matures:

- `.claude/artifacts/loop/ai-loop/02-acceptance-gates/MASTER_ACCEPTANCE_CRITERIA.md`
- `.claude/artifacts/loop/ai-loop/02-acceptance-gates/SERVICE_ACCEPTANCE_CRITERIA.md` (if applicable)
- `.claude/artifacts/loop/ai-loop/02-acceptance-gates/SECURITY_ACCEPTANCE_CRITERIA.md`
- `.claude/artifacts/loop/ai-loop/02-acceptance-gates/OBSERVABILITY_ACCEPTANCE_CRITERIA.md`
- `.claude/artifacts/loop/ai-loop/02-acceptance-gates/TESTING_ACCEPTANCE_CRITERIA.md`

**Scoring thresholds** (apply once gate files exist):

- Architecture quality ≥ 0.90
- Reliability ≥ 0.90
- Observability ≥ 0.90
- Production readiness ≥ 0.90
- Security ≥ 0.90
- Test confidence ≥ 0.80

## Allowed stop condition B — externally blocked

Remaining criteria are BLOCKED only by external dependencies the agent
cannot resolve on its own. Typical blockers:

- missing cloud credentials or subscription access
- missing third-party API keys
- unavailable Docker runtime (for local orchestration)
- missing database / vector-store credentials
- missing infrastructure state backend access

When BLOCKED, the agent must write:

- which external dependency is missing
- what was implemented up to the block
- the exact command, secret, or configuration needed to unblock
- whether other slices can still proceed in parallel

## Disallowed stop conditions

The agent must **not** stop just because:

- a slice "looks complete enough"
- the implementer "needs the user to confirm"
- a test is "too hard to write right now"
- a build warning was "probably already there"
- the next slice "is not clearly defined" (derive it per the
  Cross-Slice Continuation HARD RULE in `CLAUDE.md`)

Stopping for any reason in the disallowed list is a methodology violation.
