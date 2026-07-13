# Security review — dev no-auth mode (`auth.devNoAuth`)

**Reviewer:** independent security review (adversarial), uncommitted working-tree change
**Scope:** src/config/config.ts, src/config/writer.ts, src/server/app.ts, src/server/lib/network.ts,
src/server/routes/health.ts, src/doctor/checks.ts, src/cli/doctor.ts, README.md, and the listed test files.
Explicitly out of scope: src/providers/**, src/distill/**, tests/providers/**, tests/distill/** (unrelated
concurrent work in the same working tree).

## Verdict: NEEDS_FIX (non-blocking — one docs-only finding; no exploitable code defect found)

## Summary

The Host-header DNS-rebinding guard (`isLoopbackHostHeader`), the boot-time forced-false-on-non-loopback-bind
gate, and the config-file-only claim all hold up under adversarial testing — no bypass found. One real
finding: the feature's own doc comment and the README both overclaim that `devNoAuth` covers `/dashboard`;
it does not, and a dedicated test in the same PR proves it doesn't. That's a documentation bug, not a
security hole — it fails *safe* (dashboard stays Bearer/cookie-gated even with `devNoAuth: true`) — but it's
a false claim about an auth boundary sitting in security-relevant docs, so it should be corrected before
this ships.

## Findings

### [MEDIUM] `src/config/config.ts:22-24` and `README.md:369-370` — doc comment and README overclaim `/dashboard` coverage

`config.ts`'s `Config['auth']` doc comment says:

> "the auth `preHandler` hook skips Bearer/cookie enforcement entirely (**API + dashboard**)"

`README.md`'s "Dev no-auth mode" section says:

> "Set `auth.devNoAuth: true` in `config.yaml` to hit **the API and `/dashboard`** from local tools ...
> without supplying `Authorization: Bearer <token>` at all."

Both are false for `/dashboard`. In `src/server/app.ts:138`, the preHandler hook returns immediately for
any `/dashboard` or `/dashboard/*` path — **before** the `devNoAuthActive` branch (line 141) is ever
reached. `src/server/routes/dashboard.ts` (and its sibling `dashboard-consolidation-html.ts`,
`dashboard-jobs-html.ts`, `dashboard-search-html.ts`, `dashboard-api-html.ts`) each implement their own
independent Bearer/cookie/`?token=` bootstrap check that never reads `config.auth.devNoAuth` at all.

This is confirmed by the PR's own test, `tests/server/dev-no-auth.test.ts:94-105`
("`/dashboard` is unaffected — its own `?token=`/cookie mechanism still governs, untouched by devNoAuth"),
which asserts a 401 from `/dashboard` with `devNoAuth: true` and a hostile Host header. So the behavior is
intentional and tested — only the prose in `config.ts` and `README.md` is wrong.

Net effect: an operator who sets `devNoAuth: true` expecting passwordless `/dashboard` access will still
hit a 401 there and may go hunting for a bug that isn't one. Not exploitable (it fails toward *more*
restrictive than documented, not less), but it's a false statement about an auth boundary and should be
fixed in the same change:
- `config.ts` line ~24: drop "(API + dashboard)" → "(every route reached by this hook)" or similar, and
  note `/dashboard` is explicitly out of scope (it has always had its own independent auth, unaffected by
  this flag).
- `README.md` line 369: drop "and `/dashboard`" from the opening sentence, and add a line noting `/dashboard`
  keeps requiring its own Bearer/cookie/bootstrap-token regardless of `devNoAuth`.

## Adversarial checks performed (all clean)

1. **Host-header bypass vectors** — tested `isLoopbackHostHeader` directly against: `localhost.evil.com`,
   `127.0.0.1.evil.com`, `evil.com:127.0.0.1`, empty string, `[::1]evil`, `127.0.0.1:7777:evil`, `LOCALHOST`
   (case), `localhost.` (trailing dot), `0.0.0.0`, `127.0.0.2` (rest of 127/8), `127.1`, hex/octal/decimal IP
   forms (`0x7f.0.0.1`, `2130706433`, `017700000001`), `::ffff:127.0.0.1` (IPv4-mapped IPv6, bracketed and
   not), zero-width-space-prefixed `localhost`. **All rejected** except the genuine loopback forms
   (`127.0.0.1`, `localhost` any case, `::1` bracketed with/without port, `localhost:` with no port).
   Notably `127.0.0.2` and the IPv4-mapped-IPv6 form are correctly rejected — the check is intentionally
   *stricter* than RFC loopback (exact `127.0.0.1` only, not the whole `127/8`), which is safe, not a gap.
2. **Duplicate `Host` headers** — verified against a live raw-socket HTTP request (Node 24.16, this repo's
   runtime) that Node's HTTP parser always keeps the **first** `Host:` header sent, regardless of send
   order, and exposes only that single value as `req.headers.host`. There is no second host-routing layer
   in this daemon (no reverse proxy in front), so there's no discrepancy vector between what the guard
   checks and what anything else uses.
3. **Hook ordering / coverage** — confirmed the Host-header check runs for every request when
   `devNoAuthActive`, ahead of every route handler, with two pre-existing (not new) exemptions: `/dashboard*`
   (see MEDIUM finding above — has its own independent auth, so this is fail-safe not fail-open) and
   `/health` + `/version` when `isLocalBind` (the FEAT-406 exemption, itself gated on the same loopback
   check). `mcp.ts` registers a normal `POST /mcp` route with no special exemption — it goes through the
   hook like any other route. Grepped the whole `src/` tree for websocket usage (`websocket`, `ws(`,
   `@fastify/websocket`) — no hits in server routes; the two matches found (`backup/verify.ts`,
   `config/persist-envs.ts`) are unrelated.
4. **Boot gating from resolved bind** — `devNoAuthActive` is computed from `isLoopbackHost(config.network.host)`,
   the same predicate FEAT-406 already established (not a new mechanism). Verified `'0.0.0.0'` and `'::'`
   both correctly resolve to non-loopback and force `devNoAuth` off; `'localhost'` is accepted (by design,
   matches FEAT-406 precedent).
5. **Forced-false path is provably intact** — `tests/server/dev-no-auth.test.ts`'s "refused on non-loopback
   bind" block asserts, with `devNoAuth: true` + `network.host: '0.0.0.0'`: a request with no
   `Authorization` header still gets 401, and a request with the correct Bearer still gets 200 — i.e. the
   existing FEAT-406/430 Bearer path is untouched when the flag is refused.
6. **Response/redirect leak of bearer or cookie** — none found. The dashboard's cookie-bootstrap flow
   (`?token=` → `Set-Cookie` → 302) is entirely independent of `devNoAuth` (dashboard is exempted from the
   whole hook regardless of this flag's value), so there is no new interaction between the two mechanisms to
   leak through.
7. **Prod-sync-pairing interaction** — **documented-only, not enforced**, and clearly stated as such: no
   code anywhere ties `auth.devNoAuth` to `sync.enabled` (grepped for any cross-reference; none exists).
   The warning ("never alongside sync pairing to a prod workspace") lives purely in `README.md` prose and in
   the doctor WARN message text (`src/doctor/checks.ts` `checkDevNoAuth`, "do not run with sync pairing to
   prod"). This matches the acceptable bar set for this review (documented-only is fine if clearly stated),
   and it is clearly stated in both places.
8. **Config-file-only claim** — confirmed. Grepped `src/` for any env-var read of `devNoAuth`/`DEVNOAUTH`/
   `DEV_NO_AUTH` — no hits. `loader.ts`'s `loadConfigFromDiskRaw` only ever merges `config.yaml` content over
   `defaultConfig()`; there is no environment-variable override path for any `Config` field in this loader,
   `auth.devNoAuth` included.

## Test / typecheck output (real, not simulated)

```
$ bunx tsc --noEmit -p .
(no output — clean)
```

```
$ bunx vitest run tests/config/config.test.ts tests/config/loader.test.ts tests/config/writer.test.ts \
    tests/doctor/dev-no-auth-check.test.ts tests/server/dev-no-auth.test.ts tests/server/lib/network.test.ts

 Test Files  6 passed (6)
      Tests  118 passed (118)
   Duration  2.01s
```

Minor non-blocking observation: `tests/config/loader.test.ts` has no test round-tripping a hand-edited
`config.yaml`'s `auth:\n  devNoAuth: true` block through `parseConfigYaml`/`deepMerge` into
`Config.auth.devNoAuth`. Not a defect — `deepMerge` handles this generically, the same way it handles every
other one-level-nested boolean field, and `writer.test.ts`'s exhaustive round-trip fixture does include
`auth: { devNoAuth: true }` — just flagging the coverage gap for awareness, not requesting a fix.

## Explicit answers to the two design questions posed

- **Forced-false vs. hard-exit on `devNoAuth: true` + non-loopback bind:** forced-false (keep booting, Bearer
  stays required, loud boot-time WARN) is the right call and is provably safe — verified the Bearer path
  is fully intact in that state (finding 5 above). A hard exit would turn one dev-convenience misconfiguration
  into a full daemon outage for no additional safety margin, since forcing the flag off already leaves every
  route exactly as protected as it is today on a non-loopback bind. No objection to keeping this design.
- **Documented-only vs. enforced for the prod-sync-pairing warning:** documented-only, and that is
  acceptable given it's stated clearly in two places (README + doctor WARN) — see finding 7.

## Files reviewed / evidence trail

- `src/config/config.ts` (Config['auth'] shape + doc comment — MEDIUM finding here)
- `src/config/writer.ts` (emits `auth.devNoAuth`; exhaustive round-trip test covers it)
- `src/config/loader.ts` (confirmed no env-var override path exists for any Config field)
- `src/server/app.ts` (hook logic, ordering, forced-false gate — all verified correct)
- `src/server/lib/network.ts` (`isLoopbackHost` / `isLoopbackHostHeader` — adversarially fuzzed, no bypass)
- `src/server/routes/health.ts` (additive `auth: 'dev-no-auth'` field — correctly gated on the same predicate)
- `src/server/routes/dashboard.ts` + sibling dashboard HTML routes (independent auth, unaffected by
  `devNoAuth` — root cause of the MEDIUM finding)
- `src/doctor/checks.ts` / `src/cli/doctor.ts` (WARN row correctly gated on genuine activation, not raw config)
- `README.md` (Dev no-auth mode section — MEDIUM finding here)
- `tests/config/config.test.ts`, `tests/config/loader.test.ts`, `tests/config/writer.test.ts`,
  `tests/doctor/dev-no-auth-check.test.ts`, `tests/server/dev-no-auth.test.ts`,
  `tests/server/lib/network.test.ts` — all read, all passing (118/118)
