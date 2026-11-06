# Runbook — apply provenance-identity backfill (SLICE-447)

One-time re-stamp of memory and session rows mis-tagged with Claude Code agent-worktree directory names
(`project='agent-<hash>'` etc.). **Operator-gated:** requires hands-on decision at go/no-go gate.

**Blast radius:** Mutates `memories.project`, `memories.repo`, `sessions.project`, `sessions.repo` matching
the worktree-basename pattern (`agent-<hash>`, `<repo>-<hash>`). Unresolved rows stay unmutated by design (DEC-017 rule 1).
17,877 of 119,950 memories (15%) were mis-tagged per the 2026-11-05 audit; expected to drop to ~1,400 unresolved (rows where the worktree is deleted and cannot be resolved).

## Prerequisites

1. **SLICE-444 (ingest override) AND SLICE-445 (backfill core) merged to `main` and released.**
   - `node dist/cli/index.js doctor` → Verify "Served version" line shows the running daemon carries both slices.
   - If the daemon is stale: `node dist/cli/index.js reinstall` to materialize the latest release.

2. **Checkout migrations match the running daemon's schema.**
   ```powershell
   # Compare checkout's last migration against the installed daemon's schema
   $lastMigration = (ls migrations | Sort-Object -Descending | Select-Object -First 1).BaseName
   node dist/cli/index.js doctor 2>&1 | grep "schema version"
   ```
   - If they mismatch: `bun run build` first to rebuild `dist/` from the checkout, then re-compare.
   - **Footgun:** Running checkout CLI against prod DB auto-applies unreleased migrations; a stale `dist/` can corrupt the prod datadir.

3. **No other heavy writes underway.**
   - `node dist/cli/index.js queue` → Verify no large distill/consolidation jobs queued (they pause during backfill).

4. **Operator is present** to confirm the go/no-go gate before apply.

## Backup (safe rollback point)

```powershell
node dist/cli/index.js backup --json
```

Take note of the `snapshot_path` in the output. Rollback: `node dist/cli/index.js restore <snapshot_path>`.

## Preview (dry-run, no mutations)

```powershell
# Default — no mutation; re-run it twice and diff the counts to verify idempotence (AC-6)
node dist/cli/index.js repo-identity-backfill --column all --sessions --json > preview.json
# Human-readable output also available:
node dist/cli/index.js repo-identity-backfill --column all --sessions
```

**Read the output:**
- `scanned`: Total memories matching the bad-shape pattern.
- `would-re-stamp` (preview) / `re-stamped` (apply): Rows successfully resolved and will/did mutate.
- `unresolved`: Rows left unchanged (no session, no resolvable cwd, or git can't answer — per DEC-017).
- `reason` per unresolved row: `no-session`, `no-cwd`, `unresolved`.
- `joiningExistingCount`: Merge blast radius — how many already-correctly-tagged memories this row joins.
- `source`: Either `git-common-dir` (git resolved it) or `string-heuristic` (DEC-017 trusted worktree layout).

Run twice: `node dist/cli/index.js repo-identity-backfill --column all --sessions > run1.txt` and again to `run2.txt`.
Counts should be byte-identical (AC-6 idempotence).

## Go/no-go gate — operator confirms

Inspect `preview.json` or the human preview output. Operator signs off:

- [ ] Scanned count plausible vs. the 17,877 baseline (expect ~15% of corpus, up to 2,000–3,000 rows per column).
- [ ] `would-re-stamp` count reasonable; no candidate joins a spurious repo (check top 5–10 in `joiningExistingCount`).
- [ ] `unresolved` reasons understood; no unexpected "no-session" or "no-cwd" rows (expect <5%).
- [ ] `source` mix sensible (most `git-common-dir` or `string-heuristic` for `.claude/worktrees/agent-<id>` cases).

**If any gate is red:** Stop, investigate, and report findings before applying.

## Apply (mutation point)

```powershell
node dist/cli/index.js repo-identity-backfill --column all --sessions --json --yes
```

Expected output: `re-stamped` and `sessions-re-stamped` counts match the preview; `unresolved` matches exactly.

## Verify (AC-8 — counts and dashboard clean)

```powershell
# Verify no agent-* project names remain
node dist/cli/index.js doctor
# Expected: handler and health checks green

# Read-only count verification (do NOT run a second checkout CLI that mutates)
# Use sqlite3 directly with readonly mode:
$env:ASTRAMEM_DATADIR = "$env:LOCALAPPDATA\Astramem\memory.sqlite"
# In sqlite3:
# SELECT COUNT(*) FROM memories WHERE project GLOB 'agent-*';
# SELECT COUNT(*) FROM sessions WHERE project GLOB 'agent-*';
# Both should equal the backfill's reported `unresolved` count.
```

- **Dashboard project dropdown** (`/dashboard` UI, queryProjectOptions): Lists only real project names; no `agent-*` entries visible.
- **Final verification:** Backfill's `unresolved` count from the apply step equals the remaining `agent-*` count in the DB.

## Write-back (update repo memory)

Edit `docs/memory.md` under "Known open gaps" → "Provenance leak" entry:

```markdown
**Provenance leak: Claude Code agent-worktree dir names stored as `project` — FIXED 2026-11-05 via SLICE-447.**
Backfill applied: <scanned> rows examined, <re-stamped> re-stamped, <unresolved> left unresolved.
Current `agent-*` count matches unresolved baseline. Dashboard clean. DEC-017 trust policy enforced.
```

## Rollback (if needed)

```powershell
node dist/cli/index.js restore <snapshot_path_from_backup>
```

Then restart the daemon: `node dist/cli/index.js reinstall` (materializes the pre-backfill release).

## Known quirks

- **`reinstall --rollback` is broken:** It keeps the wrong releases (oldest + current, deletes recent ones). Use the explicit
  `restore <snapshot>` path above, not `--rollback`.
- **FEAT-439 post-merge hook:** If you merge branches locally without the lead's approval, the hook auto-reinstalls prod
  on any `migrations/` or `storage/` merge (even local branches). Preemptively: `git config --unset core.hooksPath` before
  batch-merging, then `git config core.hooksPath .git/hooks` after.
