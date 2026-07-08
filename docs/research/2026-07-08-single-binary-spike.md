# Single-binary distribution spike (FEAT-445)

*2026-07-08 · timeboxed spike, 1-day budget, actual spend: well under an hour before the falsification landed · discardable prototype under `scripts/spike/`*

## Verdict

**NEVER, via `bun build --compile`.** `better-sqlite3-multiple-ciphers` cannot be
loaded at all under the Bun *runtime* — not a bundling problem, a `dlopen` problem
that exists before `--compile` ever enters the picture. Since a Bun-compiled binary
is still a Bun-runtime executable, this kills the `bun build --compile` path outright
for this codebase, independent of any packaging cleverness.

The rest of the timebox went to the alternatives survey the design review asked for
(binding order step 3). Recommendation: **defer**, keep shipping the npm package
(`astramem-local`, already live on npm as of today, 2026-07-08) as the primary
distribution path, and treat **Node SEA** as the only technically plausible future
single-binary route — worth a follow-up spike of its own, not worth pursuing now.

---

## Step 1 — does `better-sqlite3-multiple-ciphers` load under plain `bun run`?

Per the design review's binding reorder (falsify cheapest first — do not spend the
timebox on `bun build --compile` bundling questions if the runtime itself can't load
the dependency), this ran before anything else.

Probe script: [`scripts/spike/bun-cipher-probe.cjs`](../../scripts/spike/bun-cipher-probe.cjs)
(requires the module, opens a file-backed encrypted DB, sets the cipher key, does a
round-trip insert/select). Run from repo root so `node_modules` resolves normally.

**Node (baseline — confirms the module and the probe script are both fine):**

```
$ node scripts/spike/bun-cipher-probe.cjs
probe start, runtime= node v24.16.0
required ok, ctor typeof= function
about to open file-backed encrypted db at C:\Users\serge\AppData\Local\Temp\feat445-probe.sqlite
opened file db ok
pragma key set (cipher engaged)
table created
insert ok
row= { x: 1 }
ALL GOOD
NODE_EXIT=0
```

**Bun (the falsification target):**

```
$ bun run scripts/spike/bun-cipher-probe.cjs
probe start, runtime= bun 1.3.14
required ok, ctor typeof= function
about to open file-backed encrypted db at C:\Users\serge\AppData\Local\Temp\feat445-probe.sqlite
107 |         return opts[p] || p;
108 |       })
109 |     );
110 |     tries.push(n);
111 |     try {
112 |       b = opts.path ? requireFunc.resolve(n) : requireFunc(n);
                                                     ^
error: 'better-sqlite3' is not yet supported in Bun.
Track the status in https://github.com/oven-sh/bun/issues/4290
In the meantime, you could try bun:sqlite which has a similar API.
 code: "ERR_DLOPEN_FAILED"

      at bindings (...\node_modules\bindings\bindings.js:112:48)
      at new Database (...\node_modules\better-sqlite3-multiple-ciphers\lib\database.js:48:29)
      at <anonymous> (...\scripts\spike\bun-cipher-probe.cjs:10:12)

Bun v1.3.14 (Windows x64)
BUN_EXIT=1
```

**Reading this precisely:** `require('better-sqlite3-multiple-ciphers')` *succeeds*
under Bun (`ctor typeof= function` prints) — Bun's CommonJS resolver can find and
load the JS wrapper module fine. The failure is specifically at `new Database(...)`,
i.e. Bun's `dlopen` refuses to load the compiled `.node` addon binary, with an
explicit, first-class error message naming `better-sqlite3` and pointing at a
long-standing open Bun issue (#4290), suggesting `bun:sqlite` as the sanctioned
alternative. This exactly matches the two pieces of in-repo evidence the design
review flagged (`docs/perf/2026-07-08-baseline.md`'s "isn't supported under Bun's
runtime" note, and `scripts/eval/extraction-bench/README.md`'s independent
confirmation) — now with a live, reproducible repro rather than a secondhand note.

This is a **runtime** limitation, not a version-pinning or prebuild-flag problem:
Bun's own error text frames it as a known, tracked gap in Bun's native-addon ABI
compatibility, not a "missing prebuilt binary for your platform" error (which would
look different — a `MODULE_NOT_FOUND` or a node-gyp rebuild prompt, not `ERR_DLOPEN_FAILED`
with Bun's own explanatory text).

**Consequence for `bun build --compile`:** `bun build --compile` produces a
self-contained executable that still runs on Bun's own runtime/engine internally —
it does not transparently switch to Node's ABI for native addons. Since the daemon's
two native dependencies (`better-sqlite3-multiple-ciphers`, and by the same
mechanism almost certainly `@napi-rs/keyring`, plus `sqlite-vec`'s loadable
extension) cannot be `dlopen`'d by Bun *at all*, no amount of `--compile` bundling
flag work (asset embedding, `--external`, etc.) can fix this — the failure is one
layer below where bundling operates. **Step 2 of the binding order (try
`bun build --compile` on `dist/cli/index.js` and document what breaks) is therefore
skipped**, exactly as the design review's reorder anticipated: this is the "same-day
never" the reviewer predicted, not a bundling-flag investigation.

---

## Step 3 — alternatives survey

### Node SEA (Single Executable Applications, Node 20+)

Node SEA snapshots the interpreter + a V8 code cache + embedded JS/asset blob into a
copy of the `node` binary itself, injected via `postject`. Because the resulting
executable is a real Node process (not a different runtime), native addons *can*
`dlopen` normally in principle — this sidesteps the Bun-specific wall Step 1 hit.

Caveats specific to this codebase, based on what's actually in `package.json` /
`migrations/`:

- **Native addon extraction, not embedding.** SEA's asset-embedding API
  (`sea.getAsset`) is for data blobs read back into JS; the officially documented
  pattern for `.node` addons is to ship them as real files next to the executable
  (or extract an embedded copy to a temp path at startup) rather than have Node
  `dlopen` something living inside the SEA blob directly — so "single file" is not
  literally true once `better-sqlite3-multiple-ciphers`'s native binding,
  `@napi-rs/keyring`'s native binding, and `sqlite-vec`'s loadable extension are
  accounted for. Realistically this ships as one exe + a small folder of `.node`/
  extension files, which is a materially smaller win than Supermemory's pitch.
- **Migrations directory (20 SQL files under `migrations/`).** These are read at
  runtime by path today; SEA would need them either as embedded assets (extra
  plumbing through `sea.getAsset` at every read site) or shipped alongside the exe
  as plain files — either way, more surface than the current `dist/` + `migrations/`
  layout, for no functional gain.
- **Code signing.** Injecting a blob into a copy of the `node` binary invalidates
  any existing signature; Windows/macOS both effectively require a re-sign step in
  the release pipeline that this repo's release flow (`materializeRelease` /
  `release.ts`) doesn't have today.
- **Binary size / startup.** A SEA executable is a full copy of `node` (~80–110 MB)
  plus the app blob — bigger than the current install-once-run-many `node_modules`
  approach in terms of a single artifact, though comparable to what an end user
  already has once Node is installed.

**Verdict: defer, not never.** Nothing here is fatal — it's a real, if unglamorous,
path — but it's new release-pipeline surface (signing, asset extraction, per-OS SEA
builds) for a benefit (one exe instead of `node dist/cli/index.js`) that's mostly
cosmetic given Node is already a hard prerequisite for this daemon today. Worth its
own timeboxed spike if single-binary distribution becomes a stated goal rather than
a nice-to-have; not worth building now.

**Effort estimate if pursued:** 3–5 days for a working per-OS SEA build (asset
plumbing for migrations, native-addon-next-to-exe wiring, signing on
Windows/macOS) plus CI matrix changes; ongoing cost of one more release artifact
type per platform per tag.

### `pkg` (Vercel)

Officially unmaintained since 2023; the README itself now redirects users to Node
SEA. A community fork (`@yao-pkg/pkg`) is more active but is not a first-party
Node/Bun tool. Native-addon handling in `pkg` was always the same "ship `.node`
files as unpacked assets next to the executable" pattern SEA now formalizes — so it
inherits the same non-single-file reality as SEA, with less official support behind
it. No reason to pick this over SEA now that SEA exists as a first-party Node
feature; not investigated further.

### Pragmatic baseline: `npm i -g astramem-local` + `install.sh` / `install.ps1`

This is not hypothetical — it is what's already shipping. Per this repo's own
`CLAUDE.md`, `astramem-local` was **published to npm today (2026-07-08) as v0.9.0**
(this checkout is now at `0.9.1`), SQLCipher-capable, with `bin.astramem-local` →
`dist/cli/index.js`. `npm install`'s existing native-addon toolchain (prebuilt
binaries where available, node-gyp rebuild as fallback) already handles
`better-sqlite3-multiple-ciphers` and `@napi-rs/keyring` today — this is the exact
problem class SEA/pkg exist to route around, and npm has been solving it for native
modules for over a decade with mature tooling.

What it costs the user relative to a hypothetical single binary: a Node 20+
prerequisite (already required regardless — the daemon is a Node process either
way, so this isn't an *additional* cost imposed by the install method, it's the
underlying runtime dependency the whole project has). What it does **not** cost: no
new signing pipeline, no asset-extraction plumbing for migrations, no SEA/pkg
per-OS build matrix, no version skew between a compiled snapshot and the
`node_modules` tree it was built from.

**Verdict: this is not "worse than a binary" for this audience.** The project's
actual audience (developers running a local coding-agent memory daemon who already
have Node/npm as part of their toolchain) pays effectively zero extra cost from
`npm i -g astramem-local` versus a single exe, while the project avoids all of the
signing/asset/CI-matrix cost above. The one real gap is *discoverability/onboarding
friction* for a non-Node-native user doing a first install — which `install.sh` /
`install.ps1` already target directly, and which a curl-pipe-bash one-liner (the
thing Supermemory actually optimizes for, see below) can solve without a compiled
binary at all.

---

## What Supermemory's "one binary" actually buys them that our installer doesn't

Per `docs/research/2026-07-08-supermemory-matrix.md`, Supermemory's packaging pitch
is `npx supermemory local` → "one binary, zero config" and a `curl | bash` one-line
install, landing at MED severity in that matrix's packaging-gap table (not HIGH —
the one-line-shell-install and instant-zero-config-trial rows are the HIGH gaps).
Concretely, "one binary" buys them:

1. **Zero Node/npm assumption at all** — their target user may not have Node
   installed; a real static/self-contained binary removes that prerequisite
   entirely. This is the one advantage this spike cannot replicate cheaply, because
   it requires *actually* solving the native-addon-in-a-single-file problem (SEA's
   unresolved asset-extraction/signing cost above), not just picking a different
   packaging tool.
2. **Marketing simplicity** — "one binary" is a stronger one-line pitch than "npm
   install, then run a wizard," independent of whether the technical delta is
   large. Some of Supermemory's own claimed advantage here is presentational.

What it does **not** buy them that this project's installer path is missing today:
per-OS native-addon compatibility (npm already solves this), migrations/config
management (the wizard already owns this more thoroughly than a bare binary would),
or install-time correctness checks (this project's `doctor`/preflight probes are
already stronger than "just run the exe"). The actual, honest gap is narrower than
"we don't have a single binary" — it's "we don't have a one-line curl/npx-style
zero-friction entry point," which is a shell-script and npm-publish problem, not a
`bun build --compile` problem, and is already largely closed by today's npm
publish plus the existing `install.sh`/`install.ps1`.

---

## Summary

| Step | Result |
|---|---|
| 1. Does `better-sqlite3-multiple-ciphers` load under bare `bun run`? | **No** — `ERR_DLOPEN_FAILED`, Bun's own error names the module and cites bun#4290 |
| 2. `bun build --compile` bundling investigation | **Skipped** — moot once step 1 fails; nothing to bundle for a runtime that can't load the dependency |
| 3. Alternatives survey | Node SEA = **defer** (real but costly path, 3–5 days, new signing/asset surface); `pkg` = not worth it (unmaintained, same limitations as SEA); `npm i -g` + installer scripts = **already the right answer for this audience**, already shipping as of today |

**Overall recommendation: defer single-binary distribution.** Ship-blocking need
does not exist — the npm package published today already gives this project's real
audience a low-friction install path. Revisit Node SEA specifically (not `bun build
--compile`, which is dead) if/when a genuinely Node-less-environment audience
becomes a stated priority.
