---
status: PASS
---

# Validation Result — SLICE-420 / FEAT-461 (configToYaml emit completeness)

Branch: `feat/feat-461-config-yaml` (not switched, no source edits made).
Review artifact consumed: `.claude/artifacts/crew/reviews/20260710T121205Z-review-result-slice-420-feat-461-config-yaml.md` (PASS after fix round).

All scenarios exercised the **real built CLI** (`dist/cli/index.js`) against sandboxed
`APPDATA`/`LOCALAPPDATA` directories under the session scratchpad, never `%APPDATA%\Astramem`
or `%LOCALAPPDATA%\AstraMemory`. `bun run build` / `bunx tsc -p .` ran clean before testing.

## Incident during validation (found, fixed, disclosed)

**`src/storage/keystore.ts`'s bearer/db-key credential-store identity (service `astramem-local`,
account `bearer`/`db-key`) is fixed and NOT scoped by `APPDATA`/configDir sandboxing** — it's a
single global entry per machine/user (Windows Credential Manager), same hazard the file's own
`ASTRA_MEMORY_TEST_FORCE_KEYFILE` doc-comment describes for `db-key` but which has no equivalent
bypass for `bearer`. Running the real non-interactive `init` flow (Scenario 2, required to
exercise `writeConfig` end-to-end) called `storeBearer()`, which overwrote the **production**
daemon's bearer entry in the OS credential store with a freshly-generated test token.

Caught immediately: read the real `%APPDATA%\Astramem\secrets.env` (read-only; the app itself
never rewrites this file, confirmed by code comment in `bearer-keystore.ts`) to recover the
original production bearer (`bfd63f62a389795c9af41eaccae92e4897ab078144808afda7f3e729eccc3850`),
verified via `readBearer()` that the credential store had in fact been overwritten to my test
value, then called the app's own `storeBearer()` to restore the original value — confirmed
restored and byte-identical to the `secrets.env` value afterward.

**Impact assessment:** the production daemon (PID confirmed via `Get-NetTCPConnection -LocalPort
7777`, task last-run 07:23:18, i.e. running continuously since well before this validation
started) resolves its bearer once at its own boot and does not re-read the credential store while
live — it never restarted during the ~1 minute window the entry was wrong, so no client-facing
auth break occurred. Fixed before any restart (scheduled keepalive or otherwise) could pick up the
wrong value. All subsequent scenarios avoided `init` entirely and used `ASTRA_MEMORY_TOKEN=<test
token>` (a documented override that outranks the credential store in `resolveBearerToken`'s
precedence) so the global keystore was never touched again.

**Recommend filing a follow-up FEAT**: scope the bearer/db-key credential-store account name to
something derived from configDir (or add a `ASTRA_MEMORY_TEST_FORCE_KEYFILE`-style bypass for the
bearer path, mirroring the existing db-key one) so a sandboxed `init` run — a legitimate, expected
validation/test operation per this repo's own doctrine — cannot collide with a real production
credential-store entry. This is a real, reproducible cross-contamination risk, not hypothetical.

## Scenario 1 — Build

- `bun run build` (i.e. `tsc -p .`): clean, no errors.

## Scenario 2 — Round-trip through the real flow (`init` non-interactive)

```
APPDATA=<sandbox>\appdata LOCALAPPDATA=<sandbox>\localappdata \
  ASTRA_MEMORY_INIT_NONINTERACTIVE=1 ASTRA_MEMORY_INIT_DATADIR=<sandbox datadir> \
  ASTRA_MEMORY_INIT_PORT=7778 node dist/cli/index.js init
```
Exit 0. `✓ AstraMemory Local initialized.` printed.

Inspected the real emitted `config.yaml` (not a unit-test fixture): confirmed present with
correct default values — `archival` (enabled:false, ageThresholdDays:183, usefulnessFloor:0),
`ingestIdempotency` (retentionDays:7), `distill` (durabilityGate:off), `memoryHealth`
(llmJudgedJunkSample.enabled:false), `ingest` (spoolMaxBytes:33554432), and
`consolidation.contradictionDetection` (mode:off, minSimilarity:0.6, minConfidence:0.7,
maxPerRun:200) nested under the already-emitted `consolidation` block. No `customPatterns` line
present (correctly omitted for the empty default). No `sync` key (correct, intentional
exclusion).

**Finding (non-blocking, real, worth a follow-up):** this real `init` run — a plain default
setup with no Azure/OpenAI-compatible/Codex configuration, i.e. the common case — logged:
```
{"level":40,...,"missingKeys":["azure.endpoint","azure.deployment","openaiCompatible.baseUrl","codexSubscription.authPath"],"msg":"configToYaml: emitted config is missing known Config keys"}
```
This is a **false positive** from AC-3's `findMissingConfigKeys`: these four fields are
`{ ...base.x, endpoint: answers.azureEndpoint }`-style optional fields explicitly set to
`undefined` (not absent) at emit time, and are correctly, intentionally omitted from the YAML
when falsy — the same "omit when unset" pattern used for `sidecarUrl`/`model`/etc. But
`findMissingConfigKeys`'s structural diff only checks "is the key present in cfg vs. present in
parsed YAML," not "was omission intentional," so it fires this warning on every single ordinary
`init`/`reembed-dim`/`pair` run that doesn't configure Azure/OpenAI-compat/Codex — i.e. most real
usage. The review's own AC-3 verification used `buildFullyPopulatedConfig()`, which sets
non-empty values for these fields, so it never exercised the actual default-config case where
this fires. This doesn't invalidate AC-3's core guarantee (a truly new, unwired field would still
be caught), but it undermines the "surfaces immediately... instead of silently" intent by
producing warning noise on nearly every ordinary write, which risks the real signal getting
ignored/filtered out operationally. Recommend a follow-up to special-case
optional-and-intentionally-conditional fields (`azure.endpoint`, `azure.deployment`,
`openaiCompatible.baseUrl`, `codexSubscription.authPath`, `crossEncoder.sidecarUrl`,
`crossEncoder.model`) out of the missing-key diff, or track them in a second, explicitly-documented
exclusion set alongside `SYNC_EXCLUSION`.

## Scenario 3 — Load-back fidelity

Started `node dist/cli/index.js serve --port 17778` against the sandbox config +
`ASTRA_MEMORY_DATADIR=:memory:`. Boot log: `embed preflight ok (attempt 1)`, no
`configToYaml: emitted config is missing known Config keys` warning at boot (expected — boot
only calls `loadConfigFromDisk`, not `configToYaml`). `GET /health` → `{"ok":true,...,"status":"ok"}`.
Daemon boots cleanly from the file the new writer produced, no warnings, no crash.

## Scenario 4 — Redact guard behavior (corrupted string form)

Hand-edited the sandbox `config.yaml`'s `customPatterns` to the corrupted string form
`customPatterns: "[]"` (the exact shape an old writer/loader mismatch produces, per the review's
Finding 1). Booted a fresh daemon (`ASTRA_MEMORY_TOKEN=valtoken4`, port 17779) — boots clean.
POSTed a legacy-envelope `/ingest/transcript` with content `"My email is bob@example.com and my
AWS key is AKIAABCDEFGHIJKLMNOP..."` → `HTTP 200`, `{"ok":true}`, log line `transcript ingested,
distill job enqueued` (no crash, no uncaught exception). Confirmed the daemon process (PID 34296,
via `Get-NetTCPConnection`) was still alive and `/health` still responded after the request.
Independently re-confirmed via direct `redactText({ customPatterns: '[]', ... })` call against
`dist/redact/index.js`: no throw, text passed through unredacted rather than crashing — the
`Array.isArray` guard degrades safely as designed.

## Scenario 5 — Non-empty patterns, live flow-sequence parse

Hand-edited `customPatterns` to `["sk-[a-z0-9]{8}"]` (real flow-sequence array). Booted a fresh
daemon (port 17780) — clean boot. Directly exercised the actual parse + redact path against the
real on-disk file via `dist/config/loader.js`'s `loadConfigFromDisk` + `dist/redact/index.js`'s
`redactText` (Windows-path-correct, verified with `parseConfigYaml` on the raw file text first to
rule out a path-resolution artifact): `customPatterns` loaded as a genuine JS array
(`Array.isArray === true`, value `["sk-[a-z0-9]{8}"]`), and redacting
`"here is a secret sk-ab12cd34 in the text"` produced
`"here is a secret [REDACTED:custom:808cf169] in the text"` with a matching `custom` redaction
event — proving the flow-sequence parse and the custom-pattern detector both work live against
the daemon's own written+loaded config, not just in the unit-test fixture.

## Cleanup

Both spawned daemons for scenarios 4 and 5 killed by their real listening PIDs (34296, 36764, and
the earlier scenario-3 daemon originally reported as PID 28 — actual listening PID 20736/28
resolved and killed). Production credential-store bearer verified restored and matching
`%APPDATA%\Astramem\secrets.env`. Production daemon (port 7777) confirmed still running,
undisturbed, throughout. No git operations performed beyond read. No source files edited.

## Overall

**PASS.** All five ACs behave correctly end-to-end through the real CLI/daemon, including the
Finding-1 fix (no crash on rollback-shaped corrupted config) and genuine live flow-sequence
parsing for a real custom pattern. Two non-blocking findings surfaced by exercising the real
flows (not caught by the unit-test fixtures): (1) AC-3's missing-key warning fires as noise on
essentially every ordinary `init` due to intentionally-omitted optional fields — recommend a
follow-up FEAT; (2) the bearer/db-key credential-store identity is unscoped and machine-global —
recommend a follow-up FEAT to add a keystore sandboxing bypass (mirroring the existing db-key
`ASTRA_MEMORY_TEST_FORCE_KEYFILE`) so validation/test `init` runs can never again collide with a
real production credential-store entry.
