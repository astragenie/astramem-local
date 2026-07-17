---
id: FEAT-538
status: pending
priority: P1
category: platform
target_release: RC
created: 2026-07-17
depends_on: []
derived_from: "2026-07-17 live incident — codex 401 → 187 poison jobs while /health reported status:ok"
---
# FEAT-538: Main-provider regression health check — /health must go `degraded`, not lie `ok`

## Incident (2026-07-17, live prod)

codex-subscription's refresh token was consumed ("already been used to generate a new
access token" → HTTP 401). Since codex is the live extraction provider, EVERY distill job
401'd → **187 poison jobs**. Meanwhile `GET /health` reported `status: "ok"` with the
worker ticking and embed ok. The 15-min frequent doctor caught peripheral checks
("Budget cap vs codex-subscription", "Crash loop") but NOT the actual "codex returns 401
on every call" — because the LLM chat probe (`llmChatProbe`, json:true, #299) is
`tier: 'full'` (24h cadence), so a provider auth failure has up to ~24h detection latency,
and `/health.status` is decoupled from doctor failures AND poison rate entirely.

This is the ADR-015 loud-failure invariant violated at the `/health` layer: a daemon that
is 100% broken for its core job (extraction) reports itself healthy. "Success and silent
failure look identical."

## Requested capability

1. **/health.status must reflect provider + pipeline health, not just liveness.** When the
   extraction/compaction provider is failing (auth 401/403, persistent errors) OR the
   poison rate crosses a floor OR doctor has critical reds, `/health.status` → `degraded`
   (not `ok`). Keep the O(1) liveness contract — read cached state, don't probe inline.
2. **Promote the provider chat-probe cadence** (or add a cheap provider-liveness signal) so
   a main-provider auth failure is caught in minutes, not 24h. A metered call every 15 min
   is a self-DoS (FEAT-482 class) — so use the ERROR SIGNAL from real traffic: when the
   provider returns N consecutive auth/persistent failures on actual distill calls, flip a
   cached `providerHealth: down` that /health reads. Rate/error canary, not a poll.
3. **Poison-rate alarm surfaced in /health** — `jobs.poison` climbing fast (rate, not count)
   → degraded + a structured warn (ADR-015). memory-health.ts already has POISON_RATE_ALARM
   but it's `tier:'full'` + manual-doctor-gated; wire it to the frequent tier + /health.
4. **Actionable message** — when degraded on provider auth, /health.detail should say
   exactly what to do (e.g. "codex-subscription: run `codex login`", or "switch provider").

## Acceptance criteria

- AC-1: With the extraction provider returning 401 on every call, `/health.status` becomes
  `degraded` within minutes (test with a mock provider that 401s).
- AC-2: `/health` remains O(1) (no inline provider probe on the request path).
- AC-3: A rising poison rate flips `/health.status` to `degraded` with the count + rate.
- AC-4: The degraded payload names the failing provider + the remedy.
- AC-5: A healthy daemon still reports `ok` (no false-degraded on transient blips — require
  N-consecutive or a rate threshold, not one error).

## Notes

- Pairs with the BYO providers (Wave 1, #414): DETECT the regression here + LET THE USER
  SWITCH provider there = the full resilience story. This incident is the live proof both
  are needed.
- Strong RC candidate — shipping a daemon whose `/health` says `ok` while extraction is dead
  undermines every "is it healthy?" check an operator or the watchdog makes.
