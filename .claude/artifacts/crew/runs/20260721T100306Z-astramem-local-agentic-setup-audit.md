# astramem-local — Agentic Setup Audit

Run: 20260721T100306Z. Pattern applied: `../kb/05-patterns/agentic-repo-setup.md` (machine-local
path), distilled from the [[prism]] run. Phase 1 is read-only; every action below is *proposed*
here and executed in Phase 3 only where sanctioned.

## Scope note

This repo is ~10x the doc volume of the prism reference run (486-line `CLAUDE.md`, no `AGENTS.md`,
40+ dated files under `docs/research`/`docs/specs`/`docs/eval-runs`). This audit covers root
instruction files, `.claude/` config, memory-file decision, root hygiene, and the specific
cross-references load-bearing enough to affect agent behavior (install paths, version claims,
publish flow). It does not re-grade every individual research/spec file's internal content —
those are dated investigation records, not agent-facing instructions, and are out of the pattern's
stated scope ("root instruction files, docs/ subtree grading, .claude/ config").

## Root instruction files

| Item | Grade | Evidence | Action |
|---|---|---|---|
| `AGENTS.md` | ORPHANED (missing) | `ls AGENTS.md` → not found. No tool-agnostic command/structure file exists; Codex-class agents have nothing to read. | CREATE in Phase 3. |
| `CLAUDE.md` line 21, `cd C:\work\mega\astramemory-local` | CONTRADICTED | Actual clone dir on this box is `C:\work\mega\astramem-local` (session cwd throughout this run; matches `kb/INDEX.md`'s workspace table entry `astramem-local`). GitHub repo name is `astramemory-local` (`package.json` → `repository.url`), but the local folder was renamed to match the npm package name, same pattern as `hero-crew`→`dev-team`. The hardcoded path is stale for this machine. | Fix in Phase 3: use a machine-agnostic instruction (`cd` into the repo root) rather than a hardcoded path, and note the folder-name-vs-repo-name split once. |
| `CLAUDE.md` — 486 lines, single undifferentiated file mixing mission/architecture/decisions with heavily dated volatile content (incident logs, "as of 2026-07-19" eval numbers, per-date corrections) | STALE (structural) | Pattern's altitude model: `CLAUDE.md` should be ~130 lines, stable-only. Current file has ~15 distinct dated corrections (`2026-07-13`, `-14`, `-15`, `-16`, `-19`) interleaved with stable architecture facts — exactly the sprawl failure mode the pattern targets. | Split in Phase 3: stable facts + decisions-not-to-relitigate stay in `CLAUDE.md`; every dated/volatile bullet moves to `docs/memory.md`. |
| `README.md` line 7, "Current daemon release: v0.15.1" | CONTRADICTED | `package.json:3` → `"version": "0.20.0"`. `CHANGELOG.md` top entry is `## [0.20.0] - 2026-07-20`. | Fix in Phase 3: drop the hardcoded version from prose (npm badge already shows live version) or update to current and note it will drift again — prefer removing the hardcoded number. |
| `README.md` line 683, "**Status:** v0.15.1 — ..." | CONTRADICTED | Same evidence as above — `package.json` is 0.20.0, six releases ahead. | Fix in Phase 3 (same approach — drop hardcoded version, describe capabilities not a number). |
| `README.md` body (feature descriptions: wire compat, MCP tools, memory types, provider matrix, endpoints, security, dashboard) | CURRENT | Cross-checked descriptions against `src/mcp/server.ts`-adjacent doc comments cited inline and `contracts/manifests/mcp-tools.v1.json` reference in `CLAUDE.md`; content is product-real, no template boilerplate found (unlike the prism `AGENTS.md` defect this pattern was built to catch — there is no `templates/astra-product-root/` scaffold language here). | Keep as-is; this file is already correctly scoped to end-user docs (npm page) per the altitude model — do not add agent-harness content to it. |
| `CONTRIBUTING.md` | CURRENT | Build/test/PR/publish conventions match `package.json` scripts and `docs/runbooks/release-publish.md` (mostly — see contradiction below). References `CLAUDE.md`'s "Bump discipline" section, which still exists post-rebuild. | Keep; update its `CLAUDE.md` cross-reference wording if the target section is renamed in Phase 3. |
| `SECURITY.md`, "Only the `0.10.x` line is currently supported... Upgrade to the latest `0.10.x` release" | CONTRADICTED | `package.json` is 0.20.0 — ten minor releases past the stated supported line. Pre-1.0 semver with no LTS branch (confirmed: no release branches, single `main`), so a fixed "supported line" claim goes stale every release. | Fix in Phase 3: replace with a policy statement ("pre-1.0, latest release only") instead of a version number that requires editing every bump. |
| `LICENSE` | CURRENT | Standard MIT, no dates to rot. | No action. |

## `.claude/` config

| Item | Grade | Evidence | Action |
|---|---|---|---|
| `.claude/loop.json` | CURRENT | `preset: "typescript-plugin-dev"`, build/test commands (`bun run build`, `bun run test`, `node contracts/validate.mjs`) match `package.json` scripts exactly. `productName`/`productDescription` match npm package identity. | No action. |
| `.claude/crew.json` | CURRENT | Feature flags present and structurally valid (cost-hygiene, redundant-read-stop, shell-preflight, subagent-inline-warn enabled; push-verify disabled). | No action. |
| `.claude/crew/deployment.md` | CURRENT (mostly) — one ORPHANED reference | `dev.stable: true` confirmed accepted (2026-07-12). Source-clues list cites `.github/workflows/test-xplat.yml`, which no longer exists — `git log --all --oneline -- .github/workflows/test-xplat.yml` shows it was present historically then the CI moved to `test.yml` (commits `ad13e01`→`6134298`→`700a4e1`, "drop macOS legs", "kill hosted windows leg"). | Note as historical drift only — this file is a generated deployment-guidance artifact, not hand-edited prose; not in this run's Phase 3 scope to rewrite, but flagged for the deployer role next time it regenerates. |
| `.claude/crew/{constitution,protocol,workflow}.md` | CURRENT | Present, standard Engineering OS framework files, included via `CLAUDE.md`'s `@.claude/crew/constitution.md`. Not repo-specific content — nothing to grade beyond presence. | No action. |
| `.claude/loop/rules.md` | CURRENT | Referenced from `CLAUDE.md`'s runner block; present on disk. | No action. |
| `.claude/hooks/{check_git_gate.sh,log_event.sh}` | CURRENT | Present, referenced by crew hook wiring. | No action. |
| `.claude/artifacts/{runs,handoffs,reviews,validations}` | CURRENT | Active and populated (e.g. `feat544-slice439-final-synthesis.md`, dated review artifacts through 2026-07-20) — this repo already has a live crew artifact trail. | No action. |

## Cross-reference / contradiction found outside root files

| Item | Grade | Evidence | Action |
|---|---|---|---|
| `docs/runbooks/release-publish.md` step 6, "**Publish**: `npm publish` (runs `prepublishOnly` → `bun run build` first)... With the Automation token this needs no OTP." | CONTRADICTED | `.github/workflows/publish.yml:17-20` triggers `on: push: tags: 'v*'` and its `Publish` step (`:66-84`) runs `npm publish --access public --tag ...` in CI automatically. `.claude/crew/deployment.md` (2026-07-12, already corrected once) states explicitly: *"The tag push IS the release — CI publishes automatically. Do NOT run a manual `npm publish` afterward; it collides with CI's (2026-07-12 lesson)."* The runbook still instructs a manual `npm publish` step post-tag-push — reintroducing the exact collision the deployment.md correction closed. | Fix in Phase 3: correct the runbook to say the tag push triggers CI publish; manual `npm publish` is only for local dry-run/verification, never after pushing the tag. |
| `kb/deployments/astramem-local-npm-publish.md` (kb mirror of the runbook) | CONTRADICTED (same root cause) | Mirrors the runbook's step 6 verbatim (`npm publish` as a manual step). Same evidence as above. | **Not fixed here** — kb is out of this run's edit scope per operator instruction. Reported below as a kb-worthy finding. |
| `docs/HANDOFF.md` (dated 2026-07-02, describes v0.6.0 state, "859 tests", SCHEMA_VERSION 8) | STALE (historical, not misleading) | Repo is now at v0.20.0 with 32 migrations (`CLAUDE.md`'s embed-dim section) and a much larger test suite. Not referenced from any current instruction file (`grep -rn "HANDOFF.md" *.md` → zero hits outside itself) — it's an orphaned-but-harmless dated snapshot, not actively read by agents today. | Keep as historical record (git history equivalent); add one line to the new `docs/README.md` map noting it's a point-in-time 2026-07-02 snapshot, superseded going forward by `docs/memory.md`. Do not delete — it has archival value and nothing points agents at it as current. |
| `docs/todo/v0.1.2.md` | ORPHANED | Sole file in `docs/todo/`; version `0.1.2` is 19+ releases behind current `0.20.0`. No other file references `docs/todo/`. | Flag in `docs/README.md` as a stale-version leftover; recommend the repo owner confirm it's fully superseded and delete in a follow-up (out of scope to delete unilaterally without owner confirmation — this is content, not root litter). |
| `docs/marketing.co/`-equivalent scan | N/A | No equivalent asset-dump directory found in this repo (unlike prism's `docs/marketing.co/`). | No action. |

## Root hygiene

| Item | Grade | Evidence | Action |
|---|---|---|---|
| `.aspire*.log/.pid`, `.e2e-*.log/.pid/.err`, `*-smoke.png`, `scratch/`, `.playwright-mcp/` | CURRENT (clean) | `find . -maxdepth 1` for these patterns returned nothing — root is clean, no litter to remove. | No action needed; `.gitignore` already covers `.playwright-mcp/` and equivalent categories (see below) — no further hardening required for these specific globs. |
| `.gitignore` | CURRENT | Already comprehensive and well-commented: covers `node_modules/`, `dist/`, `*.sqlite*`, `*.log`, `.env`, `secrets.env`, crew/runner state dirs, per-session harness state, eval raw-dataset exclusions (with license rationale), `.playwright-mcp/`, audio-addon binary/model caches. This is *better* than the generic pattern block — repo-specific and deliberate. | No hardening needed; do not overwrite with the generic block, it would be a downgrade. |
| `dist/`, `node_modules/`, `.eval-data/` present on disk | CURRENT | All three are gitignored (confirmed in `.gitignore`); `.eval-data/` tracks metrics but ignores raw CC-BY-NC datasets per the inline comment. Working as designed. | No action. |
| `.gitleaks.toml` (new, currently staged by a concurrent session — NOT touched by this run) | N/A — out of scope | `git status` showed `.gitleaks.toml` staged before this audit started; per operator instruction this run makes no git/index changes. | Left untouched; flagged only so the operator knows this run did not originate or interact with that staged file. |

## Secret-file protocol run

Per the pattern's mandatory protocol, checked every credential-shaped path found in the repo:

```
find . -maxdepth 3 -iname "*.env*" -o -iname "*.npmrc" -o -iname "*token*" -o -iname "*secret*" -o -iname "*.key"
```

Result: only **source code** matched (`src/cli/token.ts`, `src/config/secrets.ts`, their compiled
`dist/` counterparts, and their test files) — no actual credential-bearing files (`.env`,
`secrets.env`, `.npmrc`, key files) exist anywhere in the repo tree. The daemon's own runtime
secrets (`secrets.env`, `db.key`, the npm publish token) all live outside the repo by design
(`%APPDATA%\Astramem\secrets.env`, OS credential store, `~/.npmrc`) — confirmed by `CLAUDE.md`'s
own config-paths section and `docs/runbooks/release-publish.md`. **Verdict: clean, no
SECRET-EXPOSED finding.** No triple-check (`git check-ignore`/`git ls-files`/`git log`) was needed
because no candidate file existed to run it against.

## Memory-file decision

No `docs/memory.md` (or `.claude/crew/memory.md`) exists. `CLAUDE.md` is *already* trying to be
this file — its "Known open gaps," "Citation drift caution," "Current numbers," and dated
correction bullets are exactly the volatile content the pattern says belongs in a memory file, not
in `CLAUDE.md`. **Decision: create `docs/memory.md`**, same as prism — extract every dated/volatile
bullet out of `CLAUDE.md` into it, supersede-in-place going forward.

## Phase 3 — rebuild executed

Files created: `AGENTS.md` (new, 115 lines), `docs/memory.md` (new), `docs/README.md` (new).
Files rewritten: `CLAUDE.md` (486 -> 138 lines, split per the altitude model). Files edited
(sanctioned contradiction fixes only): `README.md` (two stale-version lines + one broken relative
link), `SECURITY.md` (stale supported-version line), `CONTRIBUTING.md` (stale manual-publish
instruction + two dangling cross-references to sections renamed/removed in the `CLAUDE.md`
rewrite), `docs/runbooks/release-publish.md` (stale manual-publish instruction). All CRLF line
endings verified before and after edit — new files were normalized from LF (the Write tool's
default) to CRLF via a PowerShell pass to match repo convention; `Edit`-tool changes to existing
CRLF files were confirmed to stay CRLF (spot-checked with `file`).

**No git operations performed** — everything above is an uncommitted working-tree change, per
instruction. `.gitleaks.toml`, staged by a concurrent session before this run started, was not
touched.

## Mechanical link-check (all files changed this run)

Scanned every `](path)` in `AGENTS.md`, `CLAUDE.md`, `README.md`, `SECURITY.md`,
`CONTRIBUTING.md`, `docs/memory.md`, `docs/README.md`, `docs/runbooks/release-publish.md` via
`rg '\]\([^)]+\)' -o`. External URLs, `mailto:`, and bare `](#anchor)` excluded per the pattern's
out-of-scope list.

- **All in-repo relative paths resolve** except one, found and fixed during this pass:
  `README.md` (pre-existing, not introduced this run) linked `[src/contracts/wire.ts](src/contracts/wire.ts)`
  — the file actually lives at `contracts/wire.ts` (top-level `contracts/` package, confirmed via
  `ls contracts/`), not under `src/`. Corrected to `[contracts/wire.ts](contracts/wire.ts)`.
- **`CLAUDE.md`'s 5 `../kb/...` links** verified to exist on disk (`../kb/12-research/astra-strategy-2026-07/README.md`,
  `../kb/08-engineering`, `../kb/10-ai-rules`, `../kb/security/12-security-standards.md`,
  `../kb/05-patterns`) — marked machine-local per the pattern, not graded as broken/not-broken
  beyond existence.
- Anchor-only links (`#dashboard`, `#dev-no-auth-mode`, `#mcp-tools-...`, etc.) were not
  individually verified against heading text — best-effort per the pattern's scope, and none were
  touched by this run's edits.

## Independent review

Dispatched `crew:reviewer` on the full diff. Verdict: **PASS-WITH-NOTES**. Two LOW findings, both
fixed post-review: (1) `AGENTS.md`'s Structure section omitted `scripts/spike/` and two loose
script files — corrected to list them; (2) this artifact's own Phase-3 line-count claims for
`AGENTS.md`/`CLAUDE.md` were wrong (self-reporting error, not a defect in the delivered docs) —
corrected to the actual `wc -l` counts (115 / 138). Review artifacts:
`.claude/artifacts/crew/reviews/20260721T101406Z-review-result-astramem-local-agentic-setup-rebuild-review.md`
(canonical) and `.claude/artifacts/crew/reviews/20260721T100306Z-review-result-agentic-setup-rebuild.md`.

## kb-worthy findings (reported, not fixed — kb is out of this run's edit scope)

1. **`kb/deployments/astramem-local-npm-publish.md` needs the same publish-flow correction** as
   `docs/runbooks/release-publish.md` (see contradiction above) — it currently tells the reader to
   run `npm publish` manually after pushing the tag, which collides with `publish.yml`'s automatic
   CI publish.
2. **`kb/INDEX.md`'s astramem-local one-liner** could note the local folder name
   (`astramem-local`) vs. GitHub repo name (`astramemory-local`) split explicitly if it doesn't
   already — this run found it already correctly listed under the `astramem-local` local folder
   name, so no drift there today, just a note that the split is real and worth keeping in sync.
