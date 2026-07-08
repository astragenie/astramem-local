# Task Handoff: Daemon disappearance under load — crashExit + unbounded process-wide handler is the mechanism

- Created: 2026-07-08T09:58:30.089Z
- From: researcher
- To: dispatcher
- Objective: The daemon DOES install global uncaughtException/unhandledRejection handlers that call process.exit(1) with no core dump by design; the worker's own tick loop and known interval jobs are well try/catch-guarded, so the more-loaded daemon dying first is consistent with a rare unguarded throw (native SQLite fault, an unawaited promise elsewhere, or OOM) hitting that handler under sustained load, but no single smoking-gun unguarded code path was found in the searched surfaces.
- Allowed Scope:
  - Read-only search of src/ for: global crash handlers
  - distill/extract Ollama call path
  - worker tick loop
  - interval jobs (consolidate/cleanup/WAL checkpoint)
  - SQLite pragmas (WAL/busy_timeout)
  - Fastify error handler
  - and NODE_OPTIONS/heap-limit config.
- Forbidden Scope: -
- Deliverable: Findings summary answering the 5 numbered questions with file:line citations (see inline report to dispatcher).
- Changed Files:
  - src/cli/serve.ts:73-85
  - 183
  - 278-330; src/pipeline/worker.ts:1-200; src/providers/llm/ollama.ts; src/providers/embed/ollama.ts; src/distill/stages/05-extract.ts; src/distill/stages/08-embed-index.ts; src/storage/db.ts:84
  - 91; src/server/app.ts:130; package.json
- Confidence: medium
- Risks: Did not read src/server/app.ts setErrorHandler body, src/pipeline/failure-classifier.ts, src/service/instance-lock.ts heartbeat, or src/pipeline/handlers/distill.ts end-to-end; did not check Windows Task Manager / Resource Monitor for actual RSS at time of death; did not check for native module (better-sqlite3-multiple-ciphers) segfault signatures; no repro was run — this is a static-code plausibility assessment only, not a confirmed root cause.
- Suggested Next Handoff: If reproducible again, capture: (a) daemon RSS/heap over time via /health or process monitor just before death, (b) the last N ingest.log lines especially any 'FATAL uncaughtException/unhandledRejection' line from serve.ts:78 which would name the exact error and stack, (c) Windows Event Viewer Application log around the death timestamp for a hidden node.exe crash entry filtered differently than assumed.

