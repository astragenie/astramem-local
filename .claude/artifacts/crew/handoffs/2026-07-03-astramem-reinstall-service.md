# Handoff — astramem-local v0.6.0 reinstall + OS service

**Date:** 2026-07-03
**Repo:** C:\work\mega\astramemory-local
**Owner → next:** switching model (→ fable)
**Confidence:** high on completed work; blocked item is a Windows perms issue, not a code issue

## Objective
User asked: check local astramem setup, get latest, reinstall, test. Then: recover stranded data, run as OS service.

## DONE (verified)
- **Updated** `main` v0.4.0 → **v0.6.0** (git pull --ff-only, 42 commits, Wave 4: sync/shipper, consolidate, encryption-at-rest, bearer keystore). Clean, no conflicts.
- **Reinstalled**: `bun install` (+`@napi-rs/keyring`, +`better-sqlite3-multiple-ciphers`), `bun run build` clean (tsc).
- **Tests**: real suite **859 passed / 0 failed**. NOTE: bare `bun run test` shows 2-3 "failures" — those are a **stale `.claude/worktrees/v0.2.1-hotfix/` copy** vitest scans, NOT repo code. Exclude with `bunx vitest run --exclude '**/.claude/**'`.
- **Data recovery** (important): v0.6.0 upgrade footgun — config.yaml `dataDir` still pointed at deprecated capital `AppData\Local\AstraMemory` (≤0.2.2 name). serve made a fresh EMPTY encrypted DB there; user's real 75 memories + 23 transcripts sat in canonical lowercase `AppData\Local\Astramem`.
  - **Fixed**: edited `%APPDATA%\Astramem\config.yaml` → `dataDir: 'C:\Users\serge\AppData\Local\Astramem'` (lowercase = canonical, matches astramem-plugin per `src/config/datadir.ts:15` + `migrate-dirs.ts`).
  - Restarted serve → auto-encrypted the real DB in place. Verified: recall returns memories, `served_7d:8`, DB header now encrypted (`c169…`, was `SQLite format 3`).
  - Deleted empty capital `AstraMemory` dir + both plaintext backups (`.plaintext-bak-*`, `.pre-encryption.bak`). Two-dir WARN gone.
- **State now**: single canonical `AppData\Local\Astramem`, DB encrypted + intact (75 mem). Roaming config/secrets already `Astramem`. Foreground daemon STOPPED (was smoke-test only).

## BLOCKED — OS service install
- `service install` (schtasks `/create /sc onlogon /tn AstraMemoryD`) **fails → falls back to Startup-shortcut** (`AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\AstraMemoryD.cmd`). Shortcut auto-starts correct v0.6.0 daemon at next logon, but gives NO `service start/stop/status` control.
- Non-elevated manual schtasks = `ERROR: Access is denied.` User ran `install-service.ps1` claiming elevation but got identical fallback → **elevation likely not actually applied, OR task-creation policy-blocked**. Node adapter (`src/service/schtasks.ts`) swallows real stderr behind "Command failed".
- **Next step handed to user** (awaiting output): run in confirmed-elevated PowerShell —
  ```powershell
  [System.Security.Principal.WindowsPrincipal]::new([System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators')   # must be True
  $tr = '"C:\Program Files\nodejs\node.exe" "C:\work\mega\astramemory-local\dist\cli\index.js" serve --port 7777'
  schtasks /create /sc onlogon /tn AstraMemoryD /tr $tr /RL LIMITED /f
  echo "EXIT=$LASTEXITCODE"
  ```
  - False → not elevated; reopen "Administrator:" window.
  - True + error → read message. Likely fixes: drop `/RL LIMITED`, or true always-on service via `/sc onstart /RU SYSTEM`.

## Files / artifacts
- Edited: `%APPDATA%\Astramem\config.yaml` (dataDir → lowercase). NOT a repo file.
- Created: `C:\work\mega\astramemory-local\install-service.ps1` (elevated installer — warms Ollama, installs+starts service via LOCAL build path, verifies /health). Untracked.
- Untracked in repo: `.claude/`, `CLAUDE.md`, `install-service.ps1`. No source code changed.

## CRITICAL gotcha for next session
- **Do NOT use bare `astramem-local`** — global bun install is **v0.3.4** (plain better-sqlite3, no cipher). Against the now-encrypted DB it throws `SqliteError: file is not a database` (SQLITE_NOTADB). Registry maxes at v0.4.0 → can't upgrade from registry. v0.5.0/v0.6.0 are git tags only, never published.
- Drive CLI via LOCAL build: `node C:\work\mega\astramemory-local\dist\cli\index.js <cmd>`.
- The schtasks task MUST be installed from the local build (bakes `"node.exe" "…\dist\cli\index.js"` via `resolveCliExecPath` in `src/cli/service.ts:13`). `install-service.ps1` already does this correctly.

## Bugs found (worth filing upstream, not yet filed)
1. Upgrade strands data on `Astramem` (lowercase, plugin-canonical) ↔ `AstraMemory` (capital, ≤0.2.2) when stale config `dataDir` overrides the default. migrate-dirs warns but does NOT copy the DB.
2. `doctor` resolves datadir differently than `serve` → 4 false "file is not a database" failures even when daemon healthy.
3. Cold Ollama load times out the first embed preflight; warm retry passes. Preflight timeout too short.
4. `src/service/schtasks.ts` swallows schtasks stderr — hides root cause (access-denied vs parse) on install failure.

## Immediate next action
Get the two-line elevation + raw-schtasks output from user → diagnose access-denied vs parse → land the real `AstraMemoryD` task → `service start` → verify `/health` ok=true, then remove the Startup-shortcut fallback `.cmd`.
