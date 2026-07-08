---
id: FEAT-447
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-08
updated: 2026-07-08
depends_on: []
slices: []
derived_from: null
---
## Description

Investigate how Supermemory achieves one-step install (curl -fsSL supermemory.ai/install | bash, npx supermemory local, supermemory-server binary). Our FEAT-445 spike (docs/research/2026-07-08-single-binary-spike.md, PR #138) proved OUR single-binary path is dead via bun build --compile (better-sqlite3-multiple-ciphers cannot dlopen under Bun runtime) and Node SEA is a 3-5 day defer — yet Supermemory ships a working single binary. Questions to answer by reading their install script + shipped artifacts (both public): (1) what does supermemory.ai/install actually download and run — a true compiled binary or a bootstrapper that installs a runtime? (2) what runtime is supermemory-server built on (Bun-compiled? Node SEA? Go/Rust sidecar — their smfs project is Rust)? (3) how do they avoid the native-addon trap — do they use a pure-JS/WASM storage engine (e.g. sqlite-wasm, no SQLCipher) instead of native sqlite, and what does that cost them (our encrypted-at-rest moat relies on the native cipher build)? (4) what can we copy cheaply: their install script UX patterns for OUR install.sh/ps1 (progress, checksums, PATH handling, uninstall), even without the binary. Deliverable: short research report in docs/research/ + a copy/adopt/skip recommendation per finding. Read-only investigation, no product changes. Effort S-M (half day).

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.