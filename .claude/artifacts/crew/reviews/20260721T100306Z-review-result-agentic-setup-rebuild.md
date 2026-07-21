---
findings: "[LOW] AGENTS.md:52-64 (Structure section) -- lists `scripts/{eval,git-hooks,perf,testbed}/` omitting the actual `scripts/spike/` subdirectory and two loose files (`gen-upgrade-fixture.mts`, `watch-daemon.ps1`). Risk: an agent orienting off AGENTS.md won't know `scripts/spike/` exists. Fix: append `,spike` to the brace list or note the loose files exist too.\n[LOW] Audit artifact 20260721T100306Z-astramem-local-agentic-setup-audit.md, Phase-3 summary -- claims \"AGENTS.md (new, 92 lines)\" and \"CLAUDE.md (486 -> ~120 lines)\"; actual line counts are 115 and 138. Risk: none to shipped docs (this is audit-narrative self-reporting, not file content), but the audit's own claim about itself is measurably off. Fix: none required for this review's PASS decision; note for whoever next edits that audit artifact."
status: completed
decision: approved_with_notes
author_id: setup-astramem
judge_id: crew-reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-21T10:21:38.984Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Independently re-verified every factual claim in AGENTS.md, CLAUDE.md, docs/memory.md, docs/README.md against actual repo state (package.json, src/config/config.ts, .github/workflows/publish.yml, CHANGELOG.md, ADR file headers, docs/ directory listing, git diff of CLAUDE.md against HEAD). All seven checklist items pass; two LOW-severity documentation gaps found, no CRITICAL/HIGH/MEDIUM issues.
- Evidence Checked:
  - 1) All 15 command families in AGENTS.md Commands section (build
  - test/test:watch/test:smoke/test:soak
  - contracts:generate/validate
  - eval:locomo:sample/run/judge/diagnose
  - eval:longmemeval:sample/smoke/judge
  - eval:extraction-bench
  - perf:baseline) verified against package.json scripts block -- every one exists verbatim.
2) AGENTS.md Structure: `ls src/` returned exactly the 29 directories listed (audio
  - backup
  - budget
  - capture
  - cli
  - config
  - consolidate
  - contracts
  - distill
  - doctor
  - entity
  - eval
  - ingest
  - log
  - mcp
  - memory-tool
  - pipeline
  - providers
  - proxy
  - recall
  - redact
  - search
  - server
  - service
  - storage
  - sync
  - tag-hygiene
  - util
  - vector) -- exact match
  - no undercount (this is the exact defect class flagged in a recalled memory from the sibling prism review
  - where a Structure list undercounted 4/11 real dirs -- checked deliberately here and it holds).
3) contradictionDetection: `defaultConfig()` (src/config/config.ts:1411
  - 1566-1567) sets `mode: 'enabled'`; `DEFAULT_CONTRADICTION_DETECTION` (line 1910-1911
  - mode:'off') is confirmed used only inside `applyContradictionDetectionGovernance` as a missing/invalid-override fallback (line 1925). CLAUDE.md's characterization is accurate. `.github/workflows/publish.yml` confirmed: `on: push: tags: 'v*'` (line 17-20) and `npm publish --access public --tag ...` in the Publish step (line 66-82).
4) docs/memory.md "Current release: v0.20.0 (2026-07-20)" matches package.json:3 (`"version": "0.20.0"`) and CHANGELOG.md's top versioned entry `## [0.20.0] - 2026-07-20` (line 12
  - after the Unreleased header).
5) docs/README.md's directory table cross-checked against full `ls docs/` plus contents of every subdirectory it describes (runbooks/ 2 files
  - hooks/ 1 file
  - security/ 1 file
  - superpowers/{plans
  - specs}
  - adr/ 20 files ADR-001..020
  - architecture/ 4 files
  - todo/ 1 file) -- every entry on disk is accounted for in the map
  - no omissions.
6) New-error check: CLAUDE.md's "ADR-001..010 (2026-07-02 original design package)" claim verified against actual ADR file headers -- ADR-001 and ADR-010 both dated 2026-07-02
  - ADR-011 dated 2026-07-03
  - ADR-020 dated 2026-07-15
  - so scoping ADR-001..010 as "the original package" is accurate
  - not an undercount of the real 20-ADR total (docs/README.md correctly states ADR-001..020 elsewhere). CLAUDE.md's "8-stage pipeline" claim verified against `src/distill/stages/01-cleanup.ts` through `08-embed-index.ts` (8 files). All stale-version fixes (README.md
  - SECURITY.md
  - CONTRIBUTING.md
  - docs/runbooks/release-publish.md) confirmed applied -- no remaining "0.15.1"/"0.10.x" strings; README's contracts/wire.ts link fix confirmed (file exists at contracts/wire.ts
  - not src/contracts/wire.ts).
   Two LOW findings: (a) AGENTS.md's Structure section lists `scripts/{eval
  - git-hooks
  - perf
  - testbed}/` but the actual scripts/ dir also has a `spike/` subdirectory and two loose files (gen-upgrade-fixture.mts
  - watch-daemon.ps1) not mentioned -- same undercount class as the recalled prism lesson
  - though minor here (one dir
  - two files
  - not a majority miss). (b) the audit run artifact's own Phase-3 summary undercounts its output: claims "AGENTS.md (new
  - 92 lines)" and "CLAUDE.md (486 -> ~120 lines)" but actual wc -l is 115 and 138 respectively -- inaccurate self-reporting in the audit narrative
  - not in the delivered docs themselves.
7) `git diff --stat HEAD -- CLAUDE.md` confirms 572 lines changed (135 insertions/485 deletions net to 138 lines) from the 486-line HEAD version. Diffed the crew:start/crew:end and runner:start/runner:end marker blocks (HEAD lines 462-486 vs new CLAUDE.md lines 114-138) byte-for-byte -- `diff` returned zero differences
  - fully preserved verbatim. New `@AGENTS.md` include at CLAUDE.md:3 uses the same `@`-prefixed include syntax as the pre-existing `@.claude/crew/constitution.md` line inside the preserved crew block -- consistent
  - not a new/invented syntax.
- Files Reviewed:
  - AGENTS.md
  - CLAUDE.md
  - docs/memory.md
  - docs/README.md
  - README.md
  - SECURITY.md
  - CONTRIBUTING.md
  - docs/runbooks/release-publish.md
- Test Adequacy: -
- Test Adequacy Skip Reason: docs-only rebuild, no runnable behavior changed -- verification was via direct filesystem/config/git cross-checks (package.json scripts, src/config/config.ts, .github/workflows/publish.yml, CHANGELOG.md, ADR headers, docs/ listing, git diff of CLAUDE.md against HEAD) rather than a test suite
- Author: setup-astramem
- Judge: crew-reviewer
- Risks: None material. Two LOW documentation-completeness gaps noted (scripts/spike undercount in AGENTS.md Structure; audit artifact's own line-count self-report is off) -- neither misleads an agent about repo behavior or commands.
- Required Follow-up: Optional: add 'spike' to AGENTS.md's scripts/{...} brace list. No action required to merge this rebuild.

