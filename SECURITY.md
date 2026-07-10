# Security Policy

## Supported versions

Only the `0.10.x` line is currently supported with security fixes. AstraMemory Local has not yet
reached a 1.0 release; there is no LTS branch. Upgrade to the latest `0.10.x` release before
reporting an issue.

| Version | Supported |
|---------|-----------|
| 0.10.x  | ✅        |
| < 0.10.0 | ❌       |

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security vulnerabilities. Instead, report privately
via one of:

- [GitHub Security Advisories](https://github.com/astragenie/astramemory-local/security/advisories/new)
  for this repository.
- Email **security@astragenie.com**.

Include the affected version, a description of the issue, and reproduction steps if possible. We
aim to acknowledge reports within a few business days.

## Security model

AstraMemory Local is designed to run entirely on your workstation, with no data leaving the
machine unless you explicitly enable sync to the AstraMemory SaaS backend. The daemon's security
posture rests on four pillars:

- **Encrypted at rest.** `memory.sqlite` is encrypted by default via `better-sqlite3-multiple-ciphers`
  (SQLCipher-compatible). The 32-byte key is resolved from the OS credential store (Windows
  Credential Manager / macOS Keychain / Linux libsecret) first, falling back to a `0600` key file
  only when the credential store is unavailable. See the [README Security section](README.md#security)
  for the full key-resolution and auto-migration behavior.
- **Bearer token authentication.** Every endpoint except `GET /health` and `GET /version` requires
  `Authorization: Bearer <token>`. The token is compared using a timing-safe comparison
  (`src/server/lib/secure-compare.ts`) to avoid leaking match-length information via response
  timing.
- **Loopback-default bind.** The daemon binds `127.0.0.1` by default — it is not reachable from the
  network unless you deliberately reconfigure the bind host, which is treated as an explicit,
  logged opt-in rather than a default.
- **Stage-0 secret redaction.** Transcript content is scanned for credentials (PEM keys, cloud
  provider keys, JWTs, generic `key=value` secrets, high-entropy strings) and redacted before it
  is ever persisted or logged.

## Known accepted limitations

Two items were flagged in our most recent internal security audit and are accepted trade-offs
given the local-only threat model (a single-user daemon bound to loopback):

1. **Dashboard bootstrap token transits the URL once.** Opening `GET /dashboard?token=<bearer>` in
   a browser (which cannot set an `Authorization` header) sends the bearer token in the URL for
   that one request. The daemon immediately exchanges it for an `HttpOnly` session cookie via a
   302 redirect to the clean URL, and strips the query string from the log line — the token does
   not persist in browser history or get re-sent by the page's auto-refresh. This is a one-time,
   mitigated exchange, not an ongoing exposure.
2. **No rate limiting on local Bearer 401s.** Failed-auth responses to `POST`/`GET` requests are
   not currently rate-limited. Given the daemon is loopback-only by default, this is a low-severity
   gap for the intended single-user deployment; it would need to be revisited if remote bind
   configurations become a supported use case.

If you believe either of these has a higher-severity implication for your deployment, please
report it through the channels above.
