---
id: FEAT-433
status: pending
priority: null
category: platform
target_release: null
created: 2026-07-05
depends_on: []
slices: []
derived_from: null
tags: [concern:reliability, concern:config]
autonomous_safe: null
triage_notes: "CLAUDE.md carried a footgun warning ('Do NOT edit config.yaml by hand while service is running — reload racey') without ever naming the actual race. Investigated: there is no live reload anywhere in the daemon — config.yaml is read exactly once per process at boot (src/config/loader.ts:93, called from resolve-runtime.ts:45). The real race is a boot/restart landing mid-write of config.yaml: writer.ts's writeConfig truncated-and-wrote in place (non-atomic), and the loader's tolerant parser never throws on a torn/partial read — it silently applies whatever fragment it could parse, or silently falls back to full defaults on a fully-empty read, with zero warning either way. Fixed in this session: writeConfig now writes via tmp-file + rename (atomic), and loadConfigFromDisk retries a transiently-empty read a few times before falling back, always WARNing (never silently defaulting) when it does. CLAUDE.md's warning updated accordingly."
---

# FEAT-433: Make config.yaml reads safe against a torn/partial write

## Problem — undocumented, unproven config race

`CLAUDE.md` told users not to hand-edit `%APPDATA%\Astramem\config.yaml`
while the service is running, calling it "reload racey" — without ever
identifying what the race actually was, or whether the risk was real.

Investigation found:

- **No live reload exists.** `config.yaml` is read exactly once per process,
  at boot, via `resolveRuntimeConfig` → `loadConfigFromDisk`
  (`src/config/loader.ts:93`, `src/config/resolve-runtime.ts:45`, called from
  `src/cli/serve.ts:44`). There is no `fs.watch`, no `SIGHUP` handler, no
  `/config/reload` route. A hand-edit while the daemon is already running has
  **zero effect** on that running process — the risk, if any, is entirely
  about what the *next* boot reads.
- **The next-boot read could be torn.** `writeConfig`
  (`src/config/writer.ts`, pre-fix) truncated `config.yaml` in place and then
  wrote the new content — not atomic. If a boot (including the schtasks
  keepalive's `PT5M` repetition trigger, or `reinstall`) landed mid-write —
  either from our own writer or from an external editor's non-atomic save —
  `readFileSync` could observe a partial file.
- **The tolerant parser made this silent, not loud.** `parseConfigYaml`
  never throws on malformed input; it just skips lines it can't parse. A
  torn read therefore never hit the existing catch-and-warn block — it
  either merged whatever partial fragment survived the truncation (some
  fields correct, others silently reverted to defaults) or, if caught at the
  moment of full truncation, read back completely empty and silently booted
  on **full defaults with no warning printed anywhere**.

## Fix applied (this session, feat/HARD-config-reload)

- `src/config/writer.ts`: `writeConfig` now writes to a sibling tmp file
  (`.config.yaml.<pid>.<ts>.tmp`) and `renameSync`s it over the target.
  `rename()` is atomic on the same filesystem (POSIX `rename(2)`; Windows via
  Node's `MoveFileEx` binding) — any reader now always sees either the
  complete old file or the complete new one, never a partial write.
- `src/config/loader.ts`: `loadConfigFromDisk` now retries a couple of times
  (short synchronous backoff) if a read comes back empty — `writeConfig`
  never emits an empty file, so an existing-but-empty read is a strong torn-
  read signal. If it's still empty after retrying, it WARNs explicitly
  (`"exists but read back empty after retrying — likely a torn read..."`)
  and falls back to defaults, rather than doing so silently. A genuinely
  malformed (non-empty) file still hits the existing catch-and-warn path.
  Behavior for well-formed configs (including the existing deep-merge
  default-fill for partial files) is unchanged.
- `CLAUDE.md`: replaced the unexplained "reload racey" warning with the
  concrete boot-only-read explanation and the new safety guarantees.

## Acceptance criteria

- Given `config.yaml` reads back empty on the first attempt but valid
  shortly after (simulated via an injectable reader in
  `tests/config/loader.test.ts`), when `loadConfigFromDisk` is called, then
  it retries and returns the valid merged config.
- Given `config.yaml` stays empty across all retry attempts, when
  `loadConfigFromDisk` is called, then it returns `defaultConfig()`, logs a
  WARN containing "torn read", and never throws.
- Given a well-formed `config.yaml` (full or partial), when
  `loadConfigFromDisk` is called, then behavior is unchanged from before this
  fix (existing roundtrip + partial-file + garbage-file tests stay green).
- Given `writeConfig` is called, when the write completes, then no
  `.tmp` file is left behind in the config directory and the target file
  contains the complete, parseable YAML.

## Refs

- `src/config/loader.ts` (`loadConfigFromDisk`, `readConfigFileWithRetry`)
- `src/config/writer.ts` (`writeConfig`)
- `src/config/resolve-runtime.ts` (single call site for daemon/doctor/backup/reinstall)
- `tests/config/loader.test.ts` (`loadConfigFromDisk torn-read handling`)
- `CLAUDE.md` ("Config reload (FEAT-433, resolved)")

## Notes

Implemented + tests green in the same session this FEAT was filed
(worktree `wt-reload`, branch `feat/HARD-config-reload`). Filed under
`pending/` per instruction to mirror sibling backlog format; ready for the
loop ceremony to promote/close in a subsequent pass.
