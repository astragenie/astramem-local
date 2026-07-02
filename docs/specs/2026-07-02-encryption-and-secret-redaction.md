# SPEC: Encryption at Rest + Secret Redaction (v0.4.0)

**Status:** proposed
**Date:** 2026-07-02
**Origin:** Astra strategy review, Pass 1 §3a / Pass 4 items #1–#2 (memory repo,
`docs/research/2026-07-02-astra-strategy-pass1-architecture.md`, `...-pass4-enterprise.md`).
90-day plan item 1 — precondition for any public launch.

## 1. Problem

The daemon captures every Claude Code session and stores both raw transcripts and distilled
memories in **plaintext SQLite** (`memory.sqlite`). Session transcripts routinely contain
pasted secrets: API keys, connection strings, env vars, private keys, internal hostnames.
Today:

- The DB file is unencrypted on disk (any process/user with file access reads everything).
- Raw transcripts are persisted **before** any scrubbing (`transcripts` table).
- When `azure-openai` providers are configured, transcript content **leaves the machine
  un-redacted** at stages 04-compact / 05-extract / 08-embed.
- The bearer token lives in a plaintext `secrets.env` (`src/cli/token.ts`).

This is a trust blocker for the product's local-first/privacy positioning and a
deal-blocker for org rollout (strategy Pass 4, T0 items #1–#2).

## 2. Goals / Non-goals

**Goals**
- G1: `memory.sqlite` (and backups) encrypted at rest by default for new installs.
- G2: Secrets are detected and redacted **before** persistence and **before** any
  cloud-LLM egress — a secret should never become a memory, an embedding, or an API payload.
- G3: Transparent migration for existing plaintext DBs.
- G4: Zero new required user configuration (secure by default; opt-out possible).

**Non-goals**
- Field-level / per-memory encryption (crypto-shredding for erasure is a future spec —
  strategy Pass 4 item #6).
- Encrypting Ollama/Azure traffic beyond existing TLS.
- DLP-grade classification of PII/names — this spec targets *credentials*, not general PII.

## 3. Requirements

| ID | Requirement |
|---|---|
| SEC-1 | The SQLite database MUST be encrypted at rest (SQLCipher-compatible, AES-256) with a key not stored alongside the DB file. |
| SEC-2 | The encryption key MUST be stored in the OS credential store (Windows Credential Manager / macOS Keychain / Linux libsecret) with a `0600` key-file fallback when no credential store is available (headless Linux). |
| SEC-3 | Ingested transcripts MUST pass a redaction stage **before** being written to the `transcripts` table. Downstream stages inherit redacted text. |
| SEC-4 | No un-redacted transcript content may be sent to a cloud provider (`azure-openai`) at any pipeline stage. |
| SEC-5 | Redaction replaces secrets with stable placeholders `[REDACTED:<type>:<hash8>]` where `hash8` = first 8 hex of SHA-256 of the secret — same secret → same placeholder (dedup-safe), value never stored. |
| SEC-6 | Redaction events are counted per type in a `redaction_log` (counts + types only, never values); surfaced via `doctor` and `/health`. |
| SEC-7 | On startup, a plaintext DB MUST be detected (SQLite magic header) and auto-migrated to encrypted form, keeping a `.pre-encryption.bak` until first successful post-migration backup. |
| SEC-8 | `backup` MUST produce encrypted output for an encrypted DB; `doctor` MUST report encryption + redaction status. |
| SEC-9 | Config surface: `security.encryption.enabled` (default `true`), `security.redaction.enabled` (default `true`), `security.redaction.entropyThreshold`, `security.redaction.customPatterns[]`. Disabling either logs a prominent warning at startup. |
| SEC-10 | (Stretch) Bearer token moves from `secrets.env` to the same credential-store abstraction as SEC-2. |

## 4. Design

### 4.1 Encryption at rest

- Swap `better-sqlite3` → **`better-sqlite3-multiple-ciphers`** (drop-in API,
  SQLCipher-compatible). Key applied via `PRAGMA key` immediately after open, before
  `sqlite-vec` extension load.
- New module `src/storage/keystore.ts`: `getOrCreateKey(): Promise<string>` —
  32-byte random key, base64; providers in order: OS credential store → key file
  (`<configDir>/db.key`, mode 0600) with startup warning.
- Migration (`src/storage/migrate-encrypt.ts`): detect `SQLite format 3\0` header →
  open plaintext, `ATTACH` encrypted target, `sqlcipher_export`, verify row counts,
  atomic rename, retain `.pre-encryption.bak` (SEC-7).
- FTS5 + sqlite-vec virtual tables live inside the same file — encrypted for free.
  Online backup of an encrypted DB copies encrypted pages (SEC-8).

### 4.2 Secret redaction

- New module `src/redact/` with a single entry `redactText(input): { text, events[] }`,
  invoked at the **ingest boundary** (`POST /ingest/transcript` handler, before the
  `transcripts` INSERT). One choke point; stages 01–08 inherit redacted text (SEC-3/4).
- Detector pack, v1:
  - **Pattern detectors:** AWS access keys (`AKIA…`), GitHub tokens (`ghp_/gho_/github_pat_`),
    Azure/GCP key patterns, generic `(api[_-]?key|secret|token|password)\s*[=:]\s*\S+`,
    JWTs (`eyJ…` triplets), PEM blocks (`-----BEGIN … PRIVATE KEY-----`),
    connection strings (`;AccountKey=`, `Password=`, `postgres://user:pass@`),
    URLs with userinfo credentials.
  - **Entropy detector:** Shannon entropy over tokens ≥ 20 chars above
    `entropyThreshold` (default 4.0 bits/char), with false-positive guards:
    skip pure-hex strings of length 40/64 adjacent to `commit|sha|hash|digest`,
    skip UUIDs, skip file paths.
  - **Custom patterns** from config (SEC-9) for org-specific formats.
- Each event → `{ type, hash8, offset }`; counts persisted to `redaction_log`
  (new table, migration `005-security.sql` — 003 is taken by expand-memory-types and 004 by
  provenance/evidence; migration ledger lives in
  `docs/superpowers/specs/2026-07-02-wave1-2-amendments-killer-features-design.md`), values discarded (SEC-5/6).

### 4.3 Surfaces

- `doctor`: prints `encryption: on (keychain)` / `redaction: on — 14 secrets redacted
  (7 github_token, 4 generic_credential, 3 high_entropy) in last 7d`.
- `/health`: adds `security: { encryption: boolean, redaction: boolean }`.
- CHANGELOG + README security section (the marketing claim must match the code).

## 5. Acceptance criteria (Given / When / Then)

**AC-1 (SEC-1/2)** Given a fresh install, When the daemon starts, Then `memory.sqlite`
is created encrypted (header ≠ `SQLite format 3`), the key exists in the OS credential
store, and all CRUD + search behave identically to plaintext mode.

**AC-2 (SEC-7)** Given an existing v0.3 plaintext DB with N memories, When the v0.4
daemon starts, Then the DB is migrated to encrypted form with N memories intact,
a `.pre-encryption.bak` exists, and a second restart does not re-migrate.

**AC-3 (SEC-3/5)** Given a transcript containing `ghp_<40 chars>` and
`Password=hunter2;`, When it is ingested, Then the `transcripts` row and every
extracted memory contain `[REDACTED:github_token:xxxxxxxx]` /
`[REDACTED:generic_credential:xxxxxxxx]` and the raw values appear nowhere in the DB
file (byte-scan assertion).

**AC-4 (SEC-4)** Given `llm.extraction.provider=azure-openai`, When a
secret-bearing transcript is distilled, Then the recorded outbound request bodies
(mock transport) contain zero un-redacted secret values.

**AC-5 (SEC-6/8)** Given redactions have occurred, When `doctor` runs, Then it reports
encryption status, key location, and per-type redaction counts; and `backup` output
cannot be opened without the key.

**AC-6 (SEC-9)** Given `security.encryption.enabled=false` in config, When the daemon
starts, Then the DB is plaintext and a WARN log line states encryption is disabled.

## 6. Test strategy

- Unit: detector pack table-driven tests (≥ 25 fixtures: true positives per type,
  false-positive guards — git SHAs, UUIDs, paths); keystore fallback ordering;
  header detection.
- Integration: fresh-encrypted lifecycle (AC-1), migration (AC-2), ingest→search
  round-trip with redaction (AC-3), mocked Azure transport capture (AC-4).
- Byte-scan helper: assert a literal never occurs in the DB file (used by AC-3/AC-5).
- Run: `bun test` (existing harness); new fixtures under `tests/security/`.

## 7. Rollout

1. Land behind `security.*` config with defaults ON for new installs.
2. v0.4.0 release: auto-migration on first start; CHANGELOG calls out the `.bak` file.
3. Post-release: SEC-10 (token → credential store) as fast-follow if not in scope.

## 8. Open questions

1. Linux headless: is key-file fallback acceptable for v0.4, or block on libsecret? (proposal: fallback + warning)
2. Should redaction also run on `/remember` (manual memory writes), not just transcripts? (proposal: yes — same choke-point module, trivial)
3. `better-sqlite3-multiple-ciphers` + `sqlite-vec` extension-load compatibility on all three OS targets — needs a spike before committing the driver swap.
