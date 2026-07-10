# FEAT-458 rollout-gate evidence — bake clock start

**Started**: 2026-07-10T17:25Z (operator-ordered: "start auto capture and do scrub evidence")
**Gate satisfied on**: 2026-07-24T17:25Z (14 days) — per ADR-013 Review decision 1.

## Actions taken

1. Production daemon upgraded v0.12.1 → **v0.13.0** (release `0.13.0+75c2056`,
   clean build from tag in a dedicated worktree, `reinstall` verified healthy,
   old release pruned). Rationale: the bake must exercise FEAT-463's
   quoted-label redaction — gate explicitly requires 463 shipped AND in play.
2. `capture.autoCapture.enabled: true` appended to prod config.yaml via
   atomic tmp+os.replace (torn-read window avoided), picked up by the
   reinstall restart.
3. Verified: `/version` → 0.13.0; `doctor` → "Auto-capture: ON — 0
   auto-captured memories currently stored"; "Secret redaction: on — 4674
   secrets redacted (4640 high_entropy, 34 generic_credential) in last 7d"
   (hook-path baseline; auto-capture counter starts at 0).

## Gate conditions being accrued (ADR-013 Decision 6 / Review decision 1)

| Condition | How verified at gate time |
|---|---|
| 14 days enabled | this file's start stamp vs current date; doctor shows ON throughout |
| No capture-caused rollback | `reinstall --rollback` not invoked for capture reasons; releases dir history |
| ≥1 REAL scrub-evidence instance | `redaction_log` rows whose transcript has `capture_source='auto_capture'` — non-synthetic, from actual session traffic. Check: join redaction_log→transcripts on session, filter capture_source, in %LOCALAPPDATA%\AstraMemory\memory.sqlite (read-only, SQLCipher key via daemon). Simpler proxy: doctor's auto-captured count > 0 AND redaction count keeps rising; exact join query at gate time. |
| FEAT-463 shipped | ✅ v0.13.0 (this deploy) |
| FEAT-467 done | tracked separately (blocks S3) |

Baseline at start: auto-captured memories = 0.

## What must NOT happen during bake

- Do not disable auto-capture (resets clock).
- Do not roll back past v0.13.0 (config now carries `capture:` block — safe
  either way, boolean scalar, but a rollback pauses the bake).
