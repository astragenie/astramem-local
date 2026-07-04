# Changing the embedding dimension (FEAT-409)

Embedding dimension (`config.embedding.dim`) is a single parameter that
flows into the vec schema, the embed providers, the boot-time preflight,
contracts, and the eval harness. The default (1024, matching
`mxbai-embed-large` / Azure `text-embedding-3-*` at `dimensions: 1024`) is
unchanged from prior releases — this only matters if you intentionally
switch to a model with a different native dimension (e.g. a 768-dim model).

There are two very different cases:

## 1. Fresh install, no existing data

Just set `embedding.dim` (and `embedding.provider`/`embedding.model`) in
`config.yaml` before the first `init` / first `serve` run. The schema is
created at whatever dim is configured — `memories_vec` is `FLOAT[D]` from
the start, no migration needed.

```yaml
embedding:
  provider: ollama
  model: some-768-dim-model
  dim: 768
```

## 2. Existing database with live data

`sqlite-vec`'s `memories_vec` is a `vec0` virtual table — its dimension is
baked into `CREATE VIRTUAL TABLE ... FLOAT[N]` at creation time. There is
no `ALTER` for it. Changing dim against a database that already has
vectors therefore requires:

1. Recreating `memories_vec` at the new dim (destructive — every existing
   vector is dropped).
2. Re-embedding every memory's text with the newly-configured provider and
   upserting into the recreated table.

**Do not do this by hand.** Use the resumable procedure below.

### Procedure

```powershell
# 1. Back up first — this is your rollback. There is no undo once step 3
#    (the schema recreate) runs.
node dist/cli/index.js backup

# 2. Stop the daemon so nothing writes to memories_vec mid-migration.
node dist/cli/index.js service stop

# 3. Run the migration. --dim is the NEW target dimension. The command
#    resolves the embed provider from your CURRENT config.embedding
#    provider/model — point config.embedding.model at the new model before
#    running this (the command verifies the provider actually produces
#    --dim-shaped vectors and aborts loud if it doesn't).
node dist/cli/index.js reembed-dim --dim 768 --yes

# 4. Restart.
node dist/cli/index.js service start
```

### Resumability

Migration 011 (`migrations/011-embed-dim-migration.sql`) added
`dim_migration_progress`, a checkpoint table keyed by
`(memory_id, target_dim)`. `reembed-dim`:

- Recreates `memories_vec` **only on the first run** for a given target
  dim — detected by "no checkpoint rows exist yet for this target_dim".
  A second invocation for the same `--dim` (e.g. after Ctrl+C, a crash, or
  a transient provider failure) skips the destructive recreate and resumes
  embedding.
- Walks memories **not yet checkpointed** for the target dim
  (`WHERE id NOT IN (SELECT memory_id FROM dim_migration_progress WHERE
  target_dim = ?)`), so completed memories are never re-embedded.
- Commits the vec upsert and the checkpoint row as adjacent
  single-statement writes per memory. If the process dies between the two,
  the next run simply re-embeds that one memory again — embedding +
  upserting is idempotent, so at-least-once execution is safe (no
  double-counting, no corrupt state).
- Exits non-zero with a per-memory failure list (`--json` reports
  `failed: [{memoryId, error}]`) if any memory's re-embed call fails
  (e.g. rate limit) — re-run the same command to retry only those.
- Persists the new dim (and the provider it verified) to `config.yaml` on
  completion, so the daemon's boot-time preflight (`embedProbe`, AC-3)
  sees a config that matches the schema it just wrote.

### Rollback

If the migration is interrupted in a state you don't trust, or the new
model turns out to be a poor fit: stop the daemon, restore the pre-change
backup with `astramem-local restore <snapshot>`, and you're back to the
old dim with the old vectors intact. There is no partial-rollback within
a single `reembed-dim` run — the backup taken in step 1 is the rollback
mechanism, not an in-place undo.
