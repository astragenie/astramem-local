# Supermemory install UX & "one binary" investigation (FEAT-447)

*2026-07-12 · read-only investigation · install script fetched and executed-path traced
live; `supermemory-server` release binary fetched in 4-20 MB chunks (head/tail) via
range requests and string-scanned for runtime/storage-engine identifiers · budget:
half day per FEAT-447*

## Verdict

**Supermemory's "one binary" is a `bun build --compile` artifact, same tool our
FEAT-445 spike falsified — they don't have a different compiler, they have a
different SQLite binding.** Their `supermemory-server` executable is unambiguously
Bun-compiled (confirmed via literal `Bun v`, `bunfs`, `oven-sh`, `process.versions.bun`,
and `standalone module graph` strings inside the downloaded ELF binary — Bun's own
compile-time vocabulary). It avoids our exact `ERR_DLOPEN_FAILED` wall because their
app code imports `Database` from **`bun:sqlite`** (found verbatim, 3×, inside the
binary) — Bun's *own built-in* SQLite binding, compiled straight into the Bun engine,
not a separate `.node` addon that needs `dlopen`. That is the entire trick. It is not
available to us for free: `bun:sqlite` wraps plain SQLite, and nothing in ~25 MB of
scanned binary content (head + tail chunks, not the full 313 MB) contains
`sqlcipher`, `SQLCipher`, `libsqlite3`, `PRAGMA key`, or `PRAGMA cipher` — every
`cipher`/`encrypt`/`AES` hit found traces to generic TLS/WebCrypto strings, not
database-page encryption. **This is a structural trade, not a process gap on our
side**: to get a Bun-compilable single binary the way they did, we would have to
give up SQLCipher-style native at-rest encryption, because the moment you need a
*different* compiled SQLite variant (a cipher build), you're back to a native addon
Bun can't `dlopen` — the exact wall FEAT-445 hit. FEAT-445's "defer Node SEA" verdict
stands; if anything this reinforces it, because it shows the one shipping
counter-example achieves single-binary status by *dropping* the very feature (native
cipher) our moat depends on, not by solving the dlopen problem.

Separately: their `smfs` project (a different, unrelated tool — an agent-oriented
NFS/FUSE filesystem, not the memory-API server) genuinely is pure Rust, confirmed via
`Cargo.toml`/`rust-toolchain.toml` in `github.com/supermemoryai/smfs`. The FEAT's
framing ("their smfs project is reportedly Rust") is correct about `smfs` itself, but
`smfs` is not what builds `supermemory-server` — conflating the two would be wrong;
they are separate repos, separate toolchains, separate binaries.

The install **script itself** (`install.sh`, fetched verbatim, 333 lines) is
genuinely well-built UX independent of the binary question, and several of its
patterns are cheap to copy into our own `install.sh`/`install.ps1` regardless of the
storage-engine finding above.

---

## Q1 — What does `curl -fsSL supermemory.ai/install | bash` actually download and run?

**Fetched directly and verbatim** (T1): `https://supermemory.ai/install` resolves to
the same script published as a GitHub release asset; I retrieved the release-asset
copy (`install.sh`, release `server-v0.0.5`,
`https://github.com/supermemoryai/supermemory/releases/download/server-v0.0.5/install.sh`,
accessed 2026-07-12) and it is **not** a runtime bootstrapper — it never installs
Node, Bun, or any package manager. It:

1. Detects OS (`darwin`/`linux` only — **no Windows branch, `die "unsupported OS"`
   otherwise**) and arch (`x64`/`arm64`, with Rosetta-2 detection forcing `arm64` on
   Apple Silicon running under translation).
2. Resolves a version (`/releases/latest` redirect parse, falling back to the REST
   API with `jq` or a `grep`/`sed` fallback if `jq` is absent — chosen specifically,
   per its own comment, because `/latest` "is not rate-limited, so install bursts
   don't 403").
3. Downloads `manifest.json` for that version tag, extracts the sha256 checksum for
   the detected platform.
4. Downloads the platform binary (`supermemory-server-<os>-<arch>`, a single ~150-313
   MB file depending on version — sizes below), verifies its sha256 against the
   manifest, `chmod +x`s it, and on macOS **re-signs it with an ad-hoc signature**
   (`codesign --force --sign -`) if the shipped signature doesn't verify.
5. Writes a thin wrapper at `~/.local/bin/supermemory-server` that sources
   `~/.supermemory/env` (600-permission secrets file) then `exec`s the real binary.
6. Interactively prompts for one of OPENAI/ANTHROPIC/GEMINI API key (re-attaching
   `/dev/tty` since stdin is consumed by the piped script body) unless one is
   pre-exported or `SUPERMEMORY_NO_PROMPT=1`.
7. Prints PATH guidance and optionally auto-starts the server in foreground.

Verbatim confirmation of the download targets, from the script itself:
```
REPO="supermemoryai/supermemory"
BIN_NAME="supermemory-server"
RELEASES_URL="https://github.com/$REPO/releases"
...
dl "$asset_base/${BIN_NAME}-${platform}" "$bin_dl" || die "binary download failed"
```

**Release asset inventory** (T1, `api.github.com/repos/supermemoryai/supermemory/releases`,
accessed 2026-07-12) — every `server-v*` release (v0.0.1-rc.8 through v0.0.5, the
newest, published 2026-07-10) ships exactly: `install.sh`, `manifest.json`, and four
platform binaries — `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, each
with a matching `.sha256`. **No `windows-x64` asset exists in any release.** Binary
sizes for `server-v0.0.5`: darwin-arm64 271.8 MB, darwin-x64 287.0 MB, linux-arm64
283.5 MB, linux-x64 313.3 MB (sizes have grown release over release — v0.0.1 was
~150-196 MB — consistent with a bundler embedding more over time, not a lean
statically-linked systems binary).

**Tier: T1** (script content fetched directly; release asset list fetched via GitHub
REST API, both live, dated 2026-07-12).

---

## Q2 — What runtime is `supermemory-server` actually built on?

**Bun-compiled, confirmed directly from the binary, not inferred from marketing.**
I downloaded byte ranges of the `linux-x64` v0.0.5 asset (first 4 MB, first 20 MB,
and the last ~5.3 MB — not the full 313 MB) via HTTP range requests and grepped the
raw bytes for runtime-identifying ASCII strings. Findings, with match counts in the
first-20MB chunk:

| String | Hits | What it means |
|---|---|---|
| `7f 45 4c 46` (ELF magic) at offset 0 | — | Linux ELF64 executable, as expected |
| `Bun v` | 11 | Bun's own version-string template |
| `bunfs` | 1 | Bun's virtual mount path used in its own runtime error messages (`bunfs/root/...`) |
| `oven-sh` | 33 | Bun's GitHub org name, embedded in Bun's own bundled license/attribution text |
| `process.versions.bun` | 1 | Bun-specific runtime API surface |
| `Bun.build` | 2 | Bun's compiler API name |
| `standalone module graph` | 1 | Bun's own internal term for what `--compile` produces |
| `import {Database} from 'bun:sqlite';` | 3 (verbatim, app source) | **the app's own bundled source code**, not a Bun-internal string |

This is the same signature class our own FEAT-445 spike's Bun error text showed
(`'better-sqlite3' is not yet supported in Bun... Track the status... bun#4290`) —
and in fact that *exact* Bun error-message text (`'better-sqlite3' is not yet
supported in Bun.` / `` `bun:sqlite` for SQLite. Don't use `better-sqlite3`. ``) is
present verbatim inside the `supermemory-server` binary too, because it's part of
Bun's own runtime error-handling table that ships in every Bun-compiled executable —
not evidence that `supermemory-server` tried and caught a `better-sqlite3` failure at
runtime. I flag this explicitly because it would be easy to misread as
supermemory-specific.

**No Go or Node-SEA signature found**: no `libnode`, no Node SEA-specific strings, no
Go runtime strings (`golang.org`, no Go build-id pattern) in the scanned ranges.
`rustc`/`cargo` appear twice each in the head chunk but in the context of generic
license-attribution text bundled by Bun for its own dependency tree, not a sign the
*server* binary itself is Rust — consistent with Q2's other finding that the actual
Rust project in this org (`smfs`) is a separate repo/binary entirely.

**Repo-level corroboration (T1):** the `supermemoryai/supermemory` monorepo's root
`package.json` (fetched raw, `raw.githubusercontent.com/supermemoryai/supermemory/main/package.json`,
2026-07-12) declares `"packageManager": "bun@1.3.6"` and Turbo-orchestrated
workspaces (`apps/*`, `packages/*`). Critically, **none of the public workspace
folders is a server app** — `apps/` contains only `browser-extension`, `docs`, `mcp`,
`memory-graph-playground`, `raycast-extension`, `web`; `packages/` contains only SDK
and tooling packages (`ai-sdk`, `agent-framework-python`, `hooks`, `memory-graph`,
`ui`, `validation`, etc.). `.github/workflows/` (11 files, listed via GitHub API) has
no `release`- or `build`-named workflow and nothing that assembles a
`supermemory-server` binary. **The source that produces `supermemory-server` is not
in this public repo at all** — only the compiled release binaries are attached to
its Releases page. This repo is publicly source-available for its SDKs/apps but the
actual local-server implementation appears closed-source, distributed as a binary
blob only.

**`smfs` (separate repo, confirmed Rust, T1):** `github.com/supermemoryai/smfs` root
contains `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, a `crates/` directory, and
its own `install.sh` + versioned releases (`v0.0.5` ships `smfs-darwin-arm64`,
`-darwin-x64`, `-linux-arm64`, `-linux-x64` + `.sha256` — again **no Windows asset**).
`smfs`'s own README (per search-result summary, not independently refetched in full —
flagged T3/unverified-in-full) describes it as "a filesystem designed for agents"
implementing an NFS/FUSE mount for semantic-search-over-files, a different product
from the memory-API server. **The FEAT's premise that "their smfs project is Rust"
is correct, but it does not build `supermemory-server`** — treating them as the same
toolchain would be wrong.

**Tier: T1** for the binary-string findings and repo structure (all directly
fetched); **T3/unverified** for the smfs README description (found via search
summary, not refetched raw in full — low-cost fact, didn't spend budget re-verifying
since it's not load-bearing for the core verdict).

---

## Q3 — How do they avoid the native-addon trap, and what does it cost them?

**They use Bun's own built-in `bun:sqlite`, not `better-sqlite3` or any external
native SQLite addon.** The literal line `import {Database} from 'bun:sqlite';`
appears three times in the scanned binary content — this is the app's actual bundled
source, and `bun:sqlite` is implemented inside the Bun engine itself (shipped as part
of the Bun binary, the same way Python ships `sqlite3` in its standard library) —
it is not a `.node` file that needs `dlopen`. That is structurally *why* their build
doesn't hit the wall FEAT-445 documented: the failure we hit is specific to
externally-compiled native addons using Node-ABI `dlopen`, and `bun:sqlite` was never
in that code path to begin with.

**What that costs them:** `bun:sqlite` wraps a vanilla (unmodified) SQLite build.
Across the scanned ~25 MB of the binary (first 4 MB, first 20 MB, last ~5.3 MB — not
exhaustive over the full 313 MB file, stated as an explicit limitation below), there
is:
- **zero** hits for `sqlcipher`, `SQLCipher`, or `libsqlite3` (a SQLCipher build
  typically links against or bundles one of these identifiably-named artifacts)
- **zero** hits for `PRAGMA key` / `PRAGMA cipher` (the exact pragma pair SQLCipher
  requires to engage the cipher — and the same pragma our own spike's probe script
  exercises against `better-sqlite3-multiple-ciphers`)
- 12 hits for the substring `cipher` — all traced to TLS cipher-suite negotiation
  strings (`defaultCipherList`, `TLSOptions.ciphers`, `getCiphers`) and X.509
  key-usage bit names (`keyEncipherment`, `dataEncipherment`), i.e. Node/Bun's
  standard WebCrypto/TLS stack, not database encryption
- 7 hits for `AES-256` / 3 for `AES-GCM` — same story, generic WebCrypto algorithm
  identifiers, not evidence of a custom at-rest scheme

This is consistent with, and now has direct binary-level corroboration for, the
existing matrix doc's assessment (`2026-07-08-supermemory-matrix.md`, row "Encrypted
at rest — Supermemory: 🔴 undocumented"): the most likely read is that Supermemory's
local server stores memories in a **plain, unencrypted SQLite file** via `bun:sqlite`,
not that encryption exists but is merely undocumented. **I cannot fully prove
absence** — the scan covered roughly 8% of the 313 MB binary (deliberately: a full
scan wasn't in scope for a half-day budget and grepping raw bytes doesn't reliably
find algorithmic behavior anyway, only string literals) — so I am stating this as
strong circumstantial evidence, not a proven negative, and logging it under
Knowledge gaps below.

**Does this structurally block them from matching our encrypted-at-rest posture the
way we do it?** Yes, in the specific sense the FEAT asks about: to get a *native*
page-level cipher (SQLCipher-style) inside a Bun-compiled single binary, they would
need a native addon carrying the cipher code — and that is exactly the class of
dependency Bun's `dlopen` refuses (per FEAT-445's `bun#4290` finding). Their
practical alternatives would be (a) skip native cipher entirely (what the evidence
suggests they did), (b) implement cipher logic in pure JS/WASM against the raw
`bun:sqlite` page format (nontrivial, and no evidence found that they did this), or
(c) drop `bun:sqlite` and go back to a native addon + accept the same dlopen
constraint we hit (defeating the point of compiling under Bun at all). **There is no
free structural trick here they found and we missed — the mechanism that lets their
binary compile is the same mechanism that would block native-cipher encryption in
that binary.** This directly reinforces, rather than changes, FEAT-445's "defer Node
SEA" verdict: the one real-world existence proof of a shipping single binary in this
space achieves it by trading away the feature our moat depends on, which is a
different trade than "we're behind on packaging" — it's a feature-vs-packaging
trade-off we've already chosen correctly for our audience (encrypted-at-rest local
memory for a coding agent).

**Tier: T1** for the binary string evidence (direct fetch + grep); inference about
"therefore no encryption" is a reasoned read of T1 evidence, not itself a T1 fact —
flagged accordingly.

---

## Q4 — What can we copy cheaply from their install script UX?

Independent of the binary/runtime question, `install.sh` has several patterns worth
lifting into our own `install.ps1`/`install.sh` (matrix doc fix-list item 1):

| Pattern (verbatim from the script) | Copy / Adopt / Skip | Note |
|---|---|---|
| SHA256 checksum verify against a published `manifest.json` before `chmod +x` | **Adopt** | Cheap, high-trust; we'd publish our own manifest alongside npm |
| `dl()`/`dlstdout()` curl-or-wget shim (works without assuming curl) | **Adopt** | One extra `command -v` check, removes a hard dependency |
| Idempotent skip: compare an installed-version marker file, no-op if current, `FORCE=1` env var to override | **Adopt** | Directly reusable for our `install.sh` wrapping `npm i -g astramem-local` |
| `/dev/tty` re-attach so prompts work when the script itself is the piped stdin | **Adopt** | Needed the moment we want any interactive step in a `curl \| bash` flow |
| Env-var prefill that silently skips a prompt if the var is already exported (`OPENAI_API_KEY` etc.) | **Adopt** | Maps directly to our `MEMORY_BEARER`/Ollama-model prompts |
| `SUPERMEMORY_NO_PROMPT` / `_NO_START` / `_FORCE` env-var escape hatches for CI/non-interactive installs | **Adopt** | We should have equivalent `ASTRAMEM_INSTALL_NO_PROMPT` etc. for CI use of our own installer |
| PATH detection + copy-pasteable shell-rc line if the bin dir isn't on PATH | **Adopt** | Same problem class as our npm-global-bin PATH friction |
| `chmod 600` on the secrets/env file, restrictive `chmod u+rwx,go-rwx` on install dirs | **Adopt** | We already treat `secrets.env` as sensitive; codify the permission calls in the installer itself rather than relying on convention |
| Root-user handling: detect `sudo`, `chown` installed files back to the invoking user, refuse to auto-start as root | **Adopt** | Real footgun class for a `curl \| sudo bash` pattern if we ever support Linux |
| macOS ad-hoc `codesign` repair on a downloaded, unsigned-by-a-real-cert binary | **Skip for now** | Only relevant once/if we ship a compiled macOS artifact (SEA is still deferred); not applicable to an `npm i -g` + Node-script installer |
| `/releases/latest` redirect for version resolution (avoids GitHub API rate limits) vs. REST API fallback with `jq`-optional parsing | **Adopt** | Same rate-limit risk applies to any installer hitting GitHub from many machines; the redirect-first / API-fallback order is worth copying verbatim as a strategy |
| Wrapper script that sources an env file then `exec`s the real binary | **Partially adopt** | We don't need a compiled-binary wrapper, but the "small stable shim that sources config then execs" shape already exists in this repo's own `astramemd.cmd` → `launch.cjs` → `current.json` pointer design (per `CLAUDE.md`) — worth noting the *pattern* validates our existing shim architecture rather than being something new to copy |

None of these require solving the native-addon/single-binary problem; they're
shell-script hygiene that applies directly to wrapping `npm i -g astramem-local`.

**Tier: T1** (all read directly from the fetched script).

---

## Contradictions

- **"one binary, zero config" marketing vs. what installs**: their own docs/README
  (T2, `raw.githubusercontent.com/.../README.md`) say "One binary. Zero config."
  The install script (T1) shows it genuinely is one binary post-download — but
  getting there still runs a multi-step bash script (platform detection, checksum
  verification, optional interactive prompt), which is a reasonable "zero config"
  claim about the *runtime* but understates the installer's own complexity relative
  to a literal single static executable a user manually places. **Resolution**:
  not a substantive contradiction — the marketing claim holds for the end state
  (one executable file, no separate runtime install), just not for the installer
  script's own internal complexity, which nobody claimed was trivial.
- **Matrix doc's "Single binary: MED severity gap...(bun compile spike — native
  better-sqlite3/keyring risk)" vs. this finding**: the matrix doc treated our
  single-binary gap as a spike risk to be resolved; FEAT-445 resolved it (dead via
  `bun build --compile`) and this FEAT confirms Supermemory's own single binary only
  works because it *avoids* the exact native modules (`better-sqlite3`,
  presumably `@napi-rs/keyring`-equivalent) that block us. **Resolution**: no
  contradiction, this closes the open question — the MED-severity packaging gap is
  real but the "how do they do it" mystery is now answered, and the answer is not
  cheaply replicable without giving up native cipher encryption.

## Trend read

Not directly applicable — this is a point-in-time architecture question, not a
market-direction one. One directional note: `server-v0.0.1-rc.8` → `v0.0.5` shipped
five releases with steadily growing binary size (152 MB → 313 MB linux-x64, i.e.
~2× growth) over what release timestamps (Last-Modified headers, T1) suggest is a
short window — the newest release lands 2026-07-10, two days before this
investigation. That's a fast-moving, actively-iterating local-server product;
`direction: rising (release cadence)`, but I only have file-size/date proxies, not a
commit-log view (source isn't public), so `confidence: low` on any cadence
extrapolation.

## Knowledge gaps

- **Binary scan was partial (~25 MB of 313 MB, ~8%)**, chosen from head+tail for
  budget reasons. The "no SQLCipher" finding is strong circumstantial evidence, not
  a proof of absence — a full scan (or, better, actually running the binary and
  inspecting the on-disk DB file header for the SQLCipher-vs-plaintext page-1
  signature) would be the next-best verification step if this becomes
  decision-critical rather than informational.
- **No direct evidence found for their vector-search implementation** (no `vec0`,
  `sqlite-vec`, `pgvector`, `lancedb`, `faiss`, or actual `hnswlib` *usage* in the
  scanned ranges — the one `hnswlib-node` string that did appear is Bun's own
  internal list of known-native-npm-packages used for its unsupported-package error
  messages, not evidence Supermemory uses it). Their "embedded graph engine" claim
  (T2 marketing copy) is unverified against source; could be pure-JS/in-memory,
  could be something not surfaced in the scanned bytes.
- **Embeddings backend unconfirmed at the binary level**: README (T2) claims default
  local embeddings via `Xenova/bge-base-en-v1.5`; no `onnxruntime`/`transformers`/
  `Xenova` strings found in the scanned chunks (8 `.wasm` hits present, weakly
  consistent with *some* WASM runtime being embedded, but not conclusive). Possible
  explanations not distinguished by this investigation: the model/runtime is
  fetched at first-run rather than embedded, or it lives in an unscanned part of the
  313 MB binary.
- **`smfs`'s own README was read via a search-engine summary, not refetched raw in
  full** — treat the "pure Rust, NFS/FUSE agent filesystem" characterization as
  T3-adjacent (search-summary-derived) even though the repo's own `Cargo.toml`/
  `rust-toolchain.toml` (directly fetched, T1) independently confirm it's a Rust
  project.
- **Why is the server's source not in the public monorepo** is inferred (closed
  binary distribution) from absence of a matching workspace/app folder and absence
  of a build/release GitHub Action — this is a reasonable read of T1 evidence but
  not a confirmed statement from Supermemory (no blog/doc found stating "the server
  is closed source"); flagging as inference, not fact.
- **mem0/letta comparison is thin by design** (secondary per the dispatch): both are
  `pip install`-based Python packages (`mem0ai`, `letta`) with no single-binary claim
  at all — sourced from a web-search summary (T3, not independently refetched from
  PyPI/docs), included only as a one-line contrast per the FEAT's "optional, don't
  chase" instruction.

## Confidence

**Medium-high** for the core verdict (Bun-compiled binary using `bun:sqlite`,
structurally excluding native-cipher encryption) — backed by directly-fetched T1
binary strings and repo structure, cross-checked against our own FEAT-445 error
signature. **Lower confidence** on the encryption-absence claim specifically (partial
scan, stated above) and on vector-engine/embeddings internals (no positive evidence
either way). Overall: strong enough to act on for the FEAT-445 "defer Node SEA"
reinforcement and the install.sh copy-list; not strong enough to publish "Supermemory
stores your data unencrypted" as a flat marketing claim without the caveats above.

## Synergy with `2026-07-08-supermemory-matrix.md` fix-list

- **Item 1 (`install.ps1`/`install.sh` one-liners)** — directly reinforced; the Q4
  table above is a concrete, cheap addition list for that item, no scope change.
- **Item 5 (single-binary spike, bun compile)** — this FEAT *is* the follow-up to
  that item (via FEAT-445, which already ran the spike and killed it) and now
  additionally explains *why* the one competitor counter-example works, closing the
  open question item 5 left dangling ("how did they do it") rather than reopening
  the spike. No change to item 5's spike-already-ran status; downgrade any residual
  urge to re-attempt `bun build --compile` — the new information (their trade-off
  costs them native cipher encryption) makes re-attempting it *less* attractive for
  us, not more, since encrypted-at-rest is the stated moat (matrix doc's "Encrypted
  at rest" row).
- **Encrypted-at-rest moat row** in the matrix doc gains direct (if partial)
  corroborating evidence rather than remaining "undocumented" by assumption alone —
  worth a doc note next time that matrix is refreshed, citing this file.
- No other fix-list items (2, 3, 4, 6, 7) are touched by this investigation.
