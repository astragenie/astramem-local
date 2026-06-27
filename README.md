# AstraMemory Local

Local-first memory daemon for AI coding agents. Wire-compatible with `memory-plugin`.

**Status: Wave 1 (foundation) shipped. Wave 2-4 in progress.**

## What works today

- SQLite + FTS5 + sqlite-vec schema (`memory.sqlite` in user-scope data dir)
- HTTP daemon on 127.0.0.1
- `POST /ingest/transcript` — wire-compat with `memory-plugin` hooks
- `GET /health`
- Bearer auth

## Coming next

- Wave 2: pipeline + providers + search + service install
- Wave 3: 8-stage memory distillation
- Wave 4: install wizard, cross-OS CI, E2E plugin flow

## Run (dev)

```bash
npm install && npm run build
ASTRA_MEMORY_TOKEN=devtok node dist/cli/index.js serve --port 7777
```

## Spec

See `../astramemory-plugin/docs/superpowers/specs/2026-06-27-astramemory-local-v1-design.md`.
