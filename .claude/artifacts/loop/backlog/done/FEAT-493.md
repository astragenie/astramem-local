---
id: FEAT-493
status: done
priority: null
category: platform
target_release: null
created: 2026-07-14
updated: 2026-07-14
depends_on: []
slices: []
derived_from: memory repo docs/research/2026-07-14-screenpipe-deep-dive.md
---
# FEAT-493: Tiered retention — Media / Lean / All (independently reimplemented)

## Description

Three-tier retention instead of binary keep/delete, independently reimplemented from the design
studied in Screenpipe (STUDY ONLY — its commercial license prohibits code reuse; take the shape,
write our own): `Media` = keep all DB rows searchable, reclaim heavy binary artifacts on disk;
`Lean` = also strip heavy derived payloads while keeping distilled memories + transcripts
searchable (actually shrinks the DB); `All` = wipe everything past the cutoff. Gives users a real
dial for disk growth — the classic always-on-daemon support complaint — instead of keep-or-wipe.
Config-gated per repo convention, sane default retention window, sanity ceiling on the days value.

## Acceptance hints

- Mode enum + per-tier delete scope; dry-run mode reports what WOULD be reclaimed first.
- Distilled memories are never deleted by Media/Lean tiers.
- Doctor stat: disk usage by category + last sweep result.

- Boundary vs the existing sibling (arch review 2026-07-14): `src/storage/archival.ts`
  (FEAT-404) already owns the MEMORY-ROW axis (non-destructive valid_to+archived flag, age +
  trailing-usefulness, cleanup-handler cadence). FEAT-493 owns the DISK-ARTIFACT axis only —
  never touch memory rows; do not duplicate or entangle with archival.ts.

## Notes

Cheap (mode enum + scoped deletes). Decide which local artifacts count as "heavy derived
payloads" (raw capture spool? transcript raws once FEAT-489 exists?) during slice derivation.

> **Closed 2026-07-17.** tiered retention disk-artifact deletion merged #406; 3 non-blocking notes tracked #408
