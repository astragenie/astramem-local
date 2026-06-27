# AstraMemory Backup and Recovery

This document covers how to back up your AstraMemory database, schedule automatic nightly backups, restore from a snapshot, and recover from database corruption.

---

## 1. Why backup

AstraMemory stores all its state — memories, raw transcripts, pipeline jobs, and budget records — in a single SQLite file (`memory.sqlite`). This file is the authoritative source of truth.

Raw transcripts cannot be re-derived from memories: once a transcript is deleted or the file is corrupted, the original conversation context is gone. Vector embeddings and FTS5 indexes are derived from memories and can be rebuilt with `astra-memory rebuild`, but the memories themselves cannot be reconstructed without the original data.

**Conclusion:** back up `memory.sqlite` regularly.

---

## 2. What is in a backup

Each snapshot is a complete, self-consistent copy of `memory.sqlite` taken via the [SQLite Online Backup API](https://www.sqlite.org/backup.html). It contains:

- `memories` — all distilled memory atoms (decisions, facts, lessons, commands, todos)
- `sessions`, `messages`, `transcripts` — raw captured conversations
- `jobs`, `artifacts` — pipeline queue state
- `budget_spend` — daily LLM cost records
- `memories_fts`, `memories_vec` — derived indexes (rebuildable, but included for consistency)
- `schema_version` — applied migration record

The backup is a valid standalone SQLite file. You can open it directly with `sqlite3` or any SQLite browser.

---

## 3. Default backup location

```
<dataDir>/backups/memory-YYYYMMDDTHHmmss.sqlite
```

`<dataDir>` defaults to:
- **Linux:** `~/.local/share/astra-memory`
- **macOS:** `~/Library/Application Support/astra-memory`
- **Windows:** `%APPDATA%\astra-memory`

Override with `ASTRA_MEMORY_DATADIR` or `--out` on a per-call basis.

---

## 4. Run a backup manually

```sh
astra-memory backup
```

**Options:**

```
--out PATH    Write the snapshot to PATH (default: <dataDir>/backups/memory-<ISO8601>.sqlite)
--keep N      After writing, prune old snapshots keeping the newest N (default: 7)
--json        Machine-readable output: {"path", "size_bytes", "duration_ms", "kept", "deleted"}
```

**Examples:**

```sh
# Default: snapshot to backups dir, keep last 7
astra-memory backup

# Custom path
astra-memory backup --out /mnt/backup/memory.sqlite

# Keep only last 3
astra-memory backup --keep 3

# Machine-readable (for scripts/CI)
astra-memory backup --json
```

The command exits 0 on success, 1 on failure (write error, disk full, DB locked for more than 30 s).

---

## 5. Schedule nightly backups

Pass `--with-backup-timer` during service installation to also install a nightly backup at 03:00 local time:

```sh
astra-memory service install --with-backup-timer
```

This creates a platform-appropriate timer/task:

| Platform | Mechanism | File written |
|---|---|---|
| Linux | systemd user timer | `~/.config/systemd/user/astra-memoryd-backup.{service,timer}` |
| macOS | launchd agent | `~/Library/LaunchAgents/com.astragenie.astra-memoryd-backup.plist` |
| Windows | Task Scheduler | Task: `AstraMemoryDBackup` (daily, 03:00) |

To install the backup timer independently after the main service is already running:

```sh
# Linux — enable the timer manually
systemctl --user enable --now astra-memoryd-backup.timer

# macOS — reload the plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.astragenie.astra-memoryd-backup.plist

# Windows — re-run service install with the flag
astra-memory service install --with-backup-timer
```

To uninstall the backup timer (the main service remains running):

- **Linux:** `systemctl --user disable --now astra-memoryd-backup.timer`
- **macOS:** `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.astragenie.astra-memoryd-backup.plist`
- **Windows:** `schtasks /delete /tn AstraMemoryDBackup /f`

Or simply run `astra-memory service uninstall` — this removes both the main service and the backup timer if present.

---

## 6. Restore from backup

Follow these steps to replace the live database with a backup snapshot.

1. **Stop the daemon** (so no new writes occur during the swap):
   ```sh
   astra-memory service stop
   # or, if running in foreground, Ctrl-C
   ```

2. **Identify the backup to restore.** List available snapshots:
   ```sh
   ls -lh ~/.local/share/astra-memory/backups/   # Linux
   ls -lh ~/Library/Application\ Support/astra-memory/backups/  # macOS
   dir "%APPDATA%\astra-memory\backups"           # Windows
   ```

3. **Copy the backup over the live file:**
   ```sh
   # Linux/macOS
   cp ~/.local/share/astra-memory/backups/memory-20260627T030000.sqlite \
      ~/.local/share/astra-memory/memory.sqlite

   # Windows (PowerShell)
   Copy-Item "$env:APPDATA\astra-memory\backups\memory-20260627T030000.sqlite" `
             "$env:APPDATA\astra-memory\memory.sqlite"
   ```

4. **Restart the daemon:**
   ```sh
   astra-memory service start
   # or foreground:
   astra-memory serve
   ```

5. **Verify health:**
   ```sh
   astra-memory doctor
   ```
   All checks should be green. If the embed/FTS indexes are stale (e.g. you restored an older backup), run:
   ```sh
   astra-memory rebuild
   ```

---

## 7. Corruption detection and recovery

### Detect corruption

`astra-memory doctor` runs an implicit write probe on the database. For an explicit SQLite integrity check:

```sh
sqlite3 ~/.local/share/astra-memory/memory.sqlite "PRAGMA integrity_check;"
# healthy output: ok
```

Doctor also performs a write-probe (`PRAGMA journal_mode`) and warns if WAL mode is missing.

### Recover from a recent backup

If `integrity_check` returns errors or the daemon crashes with `SQLITE_CORRUPT`:

1. Stop the daemon (step 1 in §6 above).
2. Rename the corrupt file so you keep it as evidence:
   ```sh
   mv memory.sqlite memory.sqlite.corrupted
   ```
3. Restore the most-recent backup (steps 3-5 in §6).

### Recover when no backup is available

If there are no backups, try SQLite's built-in `.recover` command (requires `sqlite3` CLI 3.29+):

```sh
cd ~/.local/share/astra-memory

# Attempt to recover what is readable
sqlite3 memory.sqlite.corrupted ".recover" > recovered.sql

# Load into a fresh database
sqlite3 memory.sqlite < recovered.sql
```

`.recover` extracts as much data as possible from the corrupt pages but cannot guarantee completeness. Run `PRAGMA integrity_check` on the recovered database afterward.

After recovery run `astra-memory rebuild` to regenerate FTS5 and vector indexes from the recovered memories table.

---

## 8. Retention policy

The default retention is the **newest 7 snapshots**. Older snapshots are deleted automatically when a new backup is created.

Adjust retention on any backup run:

```sh
# Keep last 14 snapshots
astra-memory backup --keep 14

# Keep last 30 (monthly-style)
astra-memory backup --keep 30
```

The retention policy applies to files matching `memory-*.sqlite` in the backups directory. Other files in the directory are left untouched.

---

## 9. Doctor backup-recency check

When `astra-memory doctor` is run with a `backupsDir` configured, it includes a backup-recency check:

- **OK** — newest backup is less than 24 h old.
- **WARN** — newest backup is older than 24 h, or no backups exist.

The check is passive: it warns but does not block daemon startup. Fix it by running `astra-memory backup` or enabling the nightly timer.
