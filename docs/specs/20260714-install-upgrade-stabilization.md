# Install / Upgrade Stabilization Plan — 2026-07-14 (#305–#279)

**Trigger:** 5 issues filed 2026-07-14, all Windows, all surfaced wiring codex on a
machine with a PRIOR install. One theme: **the existing-install → new-version
upgrade path fails five different ways.** Relevant to a beta people will INSTALL
and UPGRADE; #305 sits on the release ship-sequence itself.

## Root causes (verified against live source)

| # | Root cause | File:sym |
|---|---|---|
| #306 | `if (dbMax !== SCHEMA_VERSION) throw` conflates "DB NEWER than daemon" (upgrade footgun) with "dev forgot to bump the constant" — same dev-facing throw for both → old pinned release crash-loops with a useless message | `src/storage/migrate.ts:271` |
| #305 | `spawnSync('bun', ['install', ...])` ENOENTs when `bun` on PATH is an npm shim (bash script, not a native exe) — reinstall never touches the service | `src/service/release.ts` (`runCaptured`/materializeRelease) |
| #307 | `stopLockHolder` refuses on start-time drift ("recycled PID") with no `--force`/override → a crash-looped daemon can't be stopped via the CLI | `src/service/instance-lock.ts:216,255` |
| #279 | `reinstall` never calls `writeConfig` → an existing user's pinned `llm.*.model` (qwen3:8b) survives every upgrade forever; no doctor canary for a model that doesn't fit VRAM / is known-bad | `src/cli/reinstall.ts`, `src/doctor/checks/` |
| #308 | Old bun-global binary shadows npm-global on PATH → "unknown command: reinstall" with no hint a newer install exists; `bun remove -g` leaves shims | `src/cli/index.ts`, doctor |

## Slices (ship-path P0s first; all 5 touch DISJOINT files → parallelizable)

### SLICE-1 — #306 schema-drift: refuse-with-guidance, not crash-loop [P0]
`migrate.ts:271` — split the single throw by direction:
- **`dbMax > SCHEMA_VERSION`** (DB migrated by a NEWER daemon): throw a distinct,
  operator-facing error naming both versions + "run `astramem-local reinstall` to
  repoint the service at the current release" — NOT the dev "bump the constant" text.
- **`dbMax < SCHEMA_VERSION`** (genuine dev drift / missing migration file): keep
  the existing message.
- Loop mitigation (stretch): a serve-side detect of the newer-DB case that exits
  in a way the keepalive won't tight-loop on, or a one-shot marker. MVP = the
  actionable message so the operator knows the fix. AC: old-release-vs-new-DB
  boot prints the reinstall guidance; unit test both directions.

### SLICE-2 — #305 robust bun resolution + npm fallback [P0]
`release.ts` — resolve bun before spawning: probe `bun.exe`/`bun.cmd`, honor
`BUN_INSTALL`/`~/.bun/bin`; if no runnable bun, fall back to
`npm install --omit=dev`. AC: materializeRelease succeeds on a box where `bun` is
only an npm shim (mock spawn); a resolvable native bun still preferred.

### SLICE-3 — #307 `service stop --force` + PID re-validation [P1]
`instance-lock.ts` `stopLockHolder` + stop CLI — add `--force` that bypasses the
drift guard with a loud warning; optionally re-validate the PID's command line
(is it a node/astramem process?) before refusing on drift alone. Reuse the
`restore --force` identity-override pattern already in this file. AC: `stop --force`
kills a drift-flagged holder; plain `stop` still refuses with guidance pointing at
`--force`.

### SLICE-4 — #279 pinned-model VRAM/known-bad doctor canary + guided swap [P1]
Reuse `src/doctor/probes/gpu-vram-probe.ts` (already powers "Silent CPU offload").
New doctor check: WARN when `config.llm.*.model` doesn't fit measured VRAM or is on
a known-bad list (qwen3:8b). Plus a guided `astramem-local config upgrade-model`
that SURFACES the swap and lets the user choose — **never silently rewrite config**
(ADR-015 + the issue's own explicit instruction). AC: WARN row on a qwen3:8b-pinned
config; the command offers but does not auto-apply.

### SLICE-5 — #308 multi-install PATH-shadow detection + version/path print [P1]
`cli/index.ts` — print resolved version + binary path (cheap, on `--version`/doctor);
doctor check that WARNs when multiple `astramem-local` binaries are on PATH. Cannot
fix the OLD shadowing binary (already shipped) — forward visibility only. AC: doctor
WARNs when a second `astramem-local` is earlier on PATH.

## Sequencing
- **Wave A (P0, ship-path):** SLICE-1 + SLICE-2 in parallel worktrees. Land before the beta tag.
- **Wave B (P1):** SLICE-3, SLICE-4, SLICE-5 in parallel.
- Each: build → unit tests → crew review → CI green → merge. All disjoint files, no cross-slice contention.

## Out of scope (post-beta)
- Shipping production `node_modules` in the npm tarball (#305 alt) — bloats the package; npm-fallback is lighter.
- Auto-reinstall-on-CLI-upgrade (#306 stretch) — a prompt/hook on `npm i -g`, needs its own design.
- `bun remove -g` shim-leak (#308) — upstream bun bug; document, don't fix here.
