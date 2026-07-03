# Threat model — remote /health scrape (FEAT-406)

## Summary

By default astramemory-local binds `config.network.host` (default `127.0.0.1`) and
`GET /health` / `GET /version` are public — no `Authorization: Bearer` required. That is safe
*because* the socket is loopback-only: only processes on the same machine can reach it.

FEAT-406 lets an operator opt into a non-local bind (e.g. `0.0.0.0`, or a LAN interface address)
so a fleet-monitoring dashboard on another host can scrape health. A non-local bind changes the
threat model — the endpoint is now reachable by anything that can route to that interface, not
just local processes — so the auth boundary must move with it.

## What a non-local /health scrape exposes

`GET /health` returns, without redaction:

- `security.redaction` / `security.encryption` — whether secret-scrubbing and at-rest encryption
  are enabled on this daemon (a `false` value flags a softer target).
- `usefulness.served_7d` / `used_7d` / `rate_7d` — recall activity volume, a proxy for how much
  the memory store is used and how large the corpus likely is.
- `status` (`starting|ok|degraded`), `embed.ok` / `embed.last_error`, `worker.alive` — operational
  state that an attacker can use to time an attack (e.g. hit the daemon while the embed provider
  is degraded and retries are queuing) or to fingerprint the deployment (Ollama vs Azure, model
  name via error strings).
- `queue` state counts and `pending_proposals` — reveals ingest/consolidation volume.
- `disk_free_bytes` — free space on the data volume, useful for planning a disk-exhaustion DoS.

`GET /version` returns the daemon name, exact semver, and supported wire versions — enough to
target a known CVE for that specific build without needing to establish a session first.

None of this is memory *content* — no transcripts, no atoms, no search results. The exposure is
operational/fingerprinting information, not the user's private data. It is still real: version +
security-posture disclosure is a standard reconnaissance step, and an unauthenticated endpoint on
a non-loopback interface is scanned by mass internet crawlers within minutes of being reachable.

## Where the auth boundary sits

The boundary is derived from a single predicate, `isLoopbackHost()`
(`src/server/lib/network.ts`), applied to `config.network.host`:

- `isLoopbackHost(host)` true (`127.0.0.1`, `localhost`, `::1`) → `/health` and `/version` stay
  public, matching the pre-FEAT-406 default. Nothing changes for existing installs that never
  touch `network.host`.
- `isLoopbackHost(host)` false (any other bind, e.g. `0.0.0.0` or a LAN IP) → `/health` and
  `/version` require `Authorization: Bearer <MEMORY_BEARER>` — the identical check every other
  route already uses (`src/server/app.ts`, `preHandler` hook). Missing, wrong, or expired Bearer
  → `401`. Valid Bearer → `200`.

Both routes are gated by the *same* boolean read from the *same* config field that also decides
the actual `app.listen({ host })` call in `src/cli/serve.ts` — there is no second "require auth"
flag that could be left unset while the bind is opened up. A config typo that fails to flip the
bind also fails to flip the auth requirement (both read `cfg.network.host` together), so the
"default-unchanged" claim cannot silently drift under partial config edits.

## Explicitly out of scope

- `/dashboard` keeps its own `?token=` query-param auth (separate from the Bearer header
  mechanism) regardless of bind. It was already reachable only via that token before FEAT-406 and
  this change does not alter it.
- A push-gateway mode (daemon pushes health to a collector instead of being scraped) was
  considered and deferred — see `docs/hardening-roadmap.md` W4.6 notes. Bind + Bearer is the
  smaller, reviewable slice.
- TLS/transport encryption for the non-local bind is not addressed here — operators binding
  beyond loopback are expected to run behind their own network boundary (VPN, firewall rule, or
  reverse proxy) for transport security; the Bearer token only proves *who*, not that the wire is
  encrypted.

## Operator guidance

Leave `network.host: 127.0.0.1` (the default) unless a fleet dashboard genuinely needs to scrape
this daemon from another host. If you do change it, treat `MEMORY_BEARER` (in `secrets.env`) as
the only thing standing between the internet and this operational metadata — rotate it if it may
have leaked, and prefer binding to a specific LAN interface over `0.0.0.0` where possible.
