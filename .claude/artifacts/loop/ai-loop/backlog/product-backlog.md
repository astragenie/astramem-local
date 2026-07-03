# Product Backlog (legacy — superseded)

This file is preserved as historical reference. The active product backlog
lives in **`.claude/artifacts/loop/backlog/`** as one markdown file per feature
(`FEAT-NNN.md` in `pending/` → `triaged/` → `in-progress/` → `done/`).

See `.claude/artifacts/loop/backlog/README.md` for the schema.

Cross-Slice Continuation HARD RULE in `CLAUDE.md` scans `.claude/artifacts/loop/backlog/` for
the next unit of work; this file is no longer read by the loop.

Migrate any unfinished entries from this file into per-feature files via
`/runner:backlog add` or the one-off
`scripts/migrate-product-backlog.mjs` migration script shipped with the
plugin.
