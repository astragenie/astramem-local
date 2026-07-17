---
id: FEAT-540
status: done
priority: P1
category: platform
target_release: RC
created: 2026-07-17
depends_on: []
derived_from: "2026-07-17 codex-401 incident — daemon needed a full RESTART to recover a re-authed provider"
---
# FEAT-540: codex-subscription should reload auth.json on 401 — don't require a daemon restart

## Incident (2026-07-17)

The operator hit their ChatGPT quota → codex session invalidated → every distill 401'd →
196 poison jobs. The operator ran `codex login` (fresh token in `~/.codex/auth.json`), but
distill KEPT 401ing ("Your session has ended. Please log in again.") because the RUNNING
daemon held the old, now-dead session token in memory and never re-read the file. Recovery
required a **full daemon restart** (stop → respawn → reload auth) before requeued jobs would
complete instead of re-poisoning. A restart to recover a re-authed provider is a poor
operator experience for the DEFAULT provider.

## Requested capability

1. **On a 401/auth failure, codex-subscription re-reads `auth.json` and retries once** before
   giving up — so an operator who ran `codex login` recovers WITHOUT a daemon restart.
2. If the reloaded token is also dead (still 401 after reload), surface it loudly (feeds
   FEAT-538's providerHealth `down` + the FEAT-539 dashboard) with the "run `codex login`"
   remedy — but do not hammer (respect the N-consecutive/backoff).
3. Same reload-on-auth-failure applies to any provider that loads credentials from a file
   the operator can refresh out-of-band (codex auth.json today).

## Acceptance criteria

- AC-1: With a live daemon holding a stale codex token, writing a valid new `auth.json`
  (simulating `codex login`) → the next distill call reloads + succeeds, no restart (test
  with a mock auth loader + a provider that 401s-then-succeeds-after-reload).
- AC-2: A still-invalid token after reload → one retry, then a loud auth failure fed to
  providerHealth (FEAT-538), not an infinite reload loop.
- AC-3: No reload storm — reload at most once per failure window / with backoff.

## Notes

- Completes the resilience loop: DETECT (FEAT-538 /health degraded) → SHOW (FEAT-539
  dashboard) → SELF-HEAL (this — reload on 401) → SWITCH (BYO, #414). The incident proved
  all four belong in the RC.
- Recovery tooling from the same incident already shipped: `queue requeue --poison` (#419).

> **Closed 2026-07-17 (RC).** codex auth-reload self-heal — merged #424
