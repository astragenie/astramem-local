---
id: FEAT-447
status: done
priority: P2
category: feature
target_release: null
created: 2026-07-08
updated: 2026-07-09
depends_on: []
slices: []
derived_from: null
pm_customer_impact: 0.25
pm_effort_estimate: 0.12
pm_strategic_alignment: 0.5
pm_technical_risk: 0.05
pm_dependency_depth: 0.1
pm_composite_priority: P2
pm_autonomous_safe: true
pm_reviewed: 2026-07-09
autonomous_safe: true
triage_notes: "technical_risk 0.05 sits in the 0.0-0.2 band (known repo pattern -- read-only research, zero files touched, trivially discarded); low effort (2 pts) and moderate strategic value (feeds the report's own 'reframe local-first as default-local' messaging recommendation and possible install.sh UX borrowing) land this at P2, autonomous-safe given zero blast radius."
---
## Description

Investigate how Supermemory achieves one-step install (curl -fsSL supermemory.ai/install | bash, npx supermemory local, supermemory-server binary). Our FEAT-445 spike (docs/research/2026-07-08-single-binary-spike.md, PR #138) proved OUR single-binary path is dead via bun build --compile (better-sqlite3-multiple-ciphers cannot dlopen under Bun runtime) and Node SEA is a 3-5 day defer — yet Supermemory ships a working single binary. Questions to answer by reading their install script + shipped artifacts (both public): (1) what does supermemory.ai/install actually download and run — a true compiled binary or a bootstrapper that installs a runtime? (2) what runtime is supermemory-server built on (Bun-compiled? Node SEA? Go/Rust sidecar — their smfs project is Rust)? (3) how do they avoid the native-addon trap — do they use a pure-JS/WASM storage engine (e.g. sqlite-wasm, no SQLCipher) instead of native sqlite, and what does that cost them (our encrypted-at-rest moat relies on the native cipher build)? (4) what can we copy cheaply: their install script UX patterns for OUR install.sh/ps1 (progress, checksums, PATH handling, uninstall), even without the binary. Deliverable: short research report in docs/research/ + a copy/adopt/skip recommendation per finding. Read-only investigation, no product changes. Effort S-M (half day).

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.
## Closure note (2026-07-12)

Research complete: docs/research/20260712-feat447-supermemory-install-ux.md.
Key findings: supermemory-server = bun build --compile + bun:sqlite (no
SQLCipher evidence → likely unencrypted at rest; corroborates matrix red row);
no Windows asset; smfs is a separate Rust tool, not the server. Actionable:
port install.sh UX patterns (checksum manifest, idempotent skip, /dev/tty
re-attach, env-var prefill, PATH guidance) to our installer — candidate
follow-up FEAT if wanted. FEAT-445 defer verdict reinforced.
