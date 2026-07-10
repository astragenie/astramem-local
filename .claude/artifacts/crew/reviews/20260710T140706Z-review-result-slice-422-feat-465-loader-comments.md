---
status: PASS
---

# Review Result — SLICE-422 / FEAT-465 (quote-aware config-loader comment stripping)

- Worktree: `C:\work\mega\astramemory-local-worktrees\w465`, branch
  `feat/feat-465-loader-comments`, commits `7a330db` (original), `4459aa7` (review fix)
  vs `main`/`c947310`
- Reviewer: independent review (read-only, no edits made, worked only in this worktree)
- **Original verdict: NEEDS_FIX** (below) — **Final verdict (after `4459aa7`): PASS.**
  See re-review section at the end. Original finding: one HIGH-severity regression
  found and reproduced against the real code: the new quote-tracking `stripComment`
  misfires on an unquoted value
  containing a single (odd-count) apostrophe, silently absorbing a genuine trailing
  comment into the config value on the daemon's boot path. Confirmed this is a
  regression, not pre-existing, by diffing against the old (`c947310`) loader.
  Everything else — AC-1 through AC-6's stated fixtures, byte-stability for the
  default-config case, `splitFlowSequenceEntries`'s common-path behavior, and both
  gates — checks out.

## Finding 1 (HIGH — regression, reproduced): unquoted apostrophe corrupts a trailing comment into the value

**File:line: `src/config/loader.ts:135-161` (`stripComment`).**

The new character-scanner treats ANY bare `'` outside quote state as the *start* of a
single-quoted string (`if (ch === "'") { inSingle = true; continue; }`), with no
distinction between "this opens a real YAML single-quoted scalar" and "this is a
literal apostrophe inside unquoted prose." Once `inSingle` is (incorrectly) set, a
genuine `#` comment marker later on the same line is treated as content, not a
delimiter, because the scanner still believes it's inside a quoted string — the
comment survives unstripped and gets appended straight into the parsed value.

Reproduced directly (`parseConfigYaml`, this branch vs. `main`/`c947310` via a
throwaway git worktree, same methodology as the FEAT-461 review):

```
input:  dataDir: C:\Users\don't\AppData # a trailing comment
OLD (pre-465): { dataDir: "C:\\Users\\don't\\AppData" }              <- correct
NEW (465):     { dataDir: "C:\\Users\\don't\\AppData # a trailing comment" }  <- corrupted

input:  dataDir: C:\Users\O'Brien\AppData\Local\Astramem  # moved here 2026-01-01
OLD (pre-465): { dataDir: "C:\\Users\\O'Brien\\AppData\\Local\\Astramem" }             <- correct
NEW (465):     { dataDir: "C:\\Users\\O'Brien\\AppData\\Local\\Astramem  # moved here 2026-01-01" } <- corrupted
```

This is a genuine **regression**, not a pre-existing gap: the old, fully quote-unaware
`/(^|\s)#.*$/` regex handled these two cases correctly (by construction — it never
tracked quote state at all, so an apostrophe was simply irrelevant to it). The new
quote-tracking logic is strictly worse for this specific, very ordinary shape.

Why this is realistic and not a contrived edge case: `dataDir` (and any other unquoted
string field a user might hand-edit) commonly contains a Windows user-profile path,
and a solid fraction of real names contain an apostrophe (`O'Brien`, `D'Angelo`,
`O'Connor`, ...). More generally, ANY unquoted prose-like value with an English
contraction (`don't`, `it's`, `can't`, `user's`) followed by a hand-added trailing
`#` comment — an extremely natural thing for an operator to type — hits this. The
failure mode is **silent**: no warning, no parse error, just a corrupted value quietly
merged into the running daemon's config. For `dataDir` specifically, this changes
where the daemon reads/writes its SQLite file — a boot-time correctness bug in the
literal sense the review focus called out ("a parse bug = daemon boots with corrupted
config").

**Confirmed exactly which inputs are safe vs. affected:** the bug requires an **odd**
number of unquoted apostrophes before the real `#`. I verified a line with **two**
apostrophes before the comment (`note: it's a test's value # comment`) parses
correctly, because the second apostrophe closes the erroneously-opened quote state
before the scanner reaches the `#` — this is why the bug can look intermittent/
"working" in casual testing and slip past a builder who tests only their own AC
fixtures (none of which include an unquoted apostrophe).

**Recommended fix direction:** the quote-open heuristic needs a way to distinguish a
real YAML single-quoted scalar (which, in this loader's dialect, only ever starts
immediately after the `key:` separator or as a flow-sequence entry boundary — see
`splitFlowSequenceEntries`'s own approach) from a bare apostrophe appearing mid-value.
The simplest correct fix: `stripComment` should only ever consider entering quote-
state at the position where a scalar VALUE begins (right after `key:`), not at an
arbitrary `'` anywhere in the line — mirroring how `parseConfigYaml` already knows
where the value starts (`line.slice(colon + 1)`). Alternatively, only treat `'`/`"` as
a quote-open when it's the very first non-whitespace character of the value; once a
value doesn't open with a quote, it's an unquoted scalar and no apostrophe inside it
should ever flip quote state (matching YAML's own grammar, where an unquoted scalar
can contain a literal `'` anywhere without special meaning). This needs to be fixed
before merge — it's a silent data-corruption regression on the config boot path,
exactly the failure class this review was scoped to catch.

## 2. `parseScalar` double-quote unwrapping — no regression found

Confirmed `writer.ts`'s `yamlScalar` only ever emits **single**-quoted strings when
quoting is needed (`return \`'${v.replace(/'/g, "''")}'\`;`) — the new double-quote
branch in `parseScalar` is purely additive for hand-edited configs and can never
regress anything the writer itself produces. Verified byte-stability directly: wrote
`defaultConfig()` with the current writer, loaded it with both the old (`c947310`)
and new (`7a330db`) loaders — **deep-equal, identical Config objects** (JSON-stringify
match). No existing writer-emitted shape is affected by the new double-quote handling.

## 3. `splitFlowSequenceEntries` — common-path behavior correct, one disclosed edge case confirmed

Tested directly against `parseConfigYaml`:
- Commas inside a quoted entry (`['a,b', 'c']`): correctly preserved as one entry, not
  split. Correct.
- Empty array (`[]`), single entry (`['solo']`), trailing comma (`['a', 'b',]`): all
  parse correctly (trailing comma silently dropped rather than producing an empty
  trailing entry — reasonable).
- Mixed quote styles with `#` in each entry: both entries preserved with `#` intact,
  entry count correct — matches AC-2 exactly.
- **Nested brackets**: confirmed this degrades **silently**, not loudly, and only for
  the non-JSON fallback path. A single-entry nested array (`[['nested'], 'x']`)
  happens to parse correctly by accidental recursion (the outer split isolates
  `['nested']` as one entry, which `parseScalar`'s own recursive `[...]` branch then
  re-parses correctly). But a **multi-entry** nested array via the fallback path
  (`[['a', 'b'], 'x']` — single-quoted, so it fails `JSON.parse` and hits the manual
  splitter) is genuinely corrupted: `splitFlowSequenceEntries` doesn't track bracket
  depth at all, so the comma between `'a'` and `'b'` — outside any quote, per its own
  logic — is treated as a top-level split point, producing
  `["['a'", "'b']", "x"]` instead of `[["a","b"], "x"]`. The equivalent **double**-
  quoted form goes through `JSON.parse` instead and parses correctly regardless of
  nesting depth, since `JSON.parse` has no such limitation.
  **Not blocking**: no current `Config` field is array-of-arrays (`customPatterns` is
  the only array-typed field, flat `string[]`), so this can't be hit through normal
  writer→loader round-tripping today, and the handoff's own "Risks/open questions"
  section already discloses "no nested brackets/objects" as an accepted, out-of-scope
  boundary. Worth a one-line comment in `splitFlowSequenceEntries` noting the silent
  (not loud) degradation for a hypothetical future nested-array field, but not a
  reason to block this slice.

## 4. Cross-check: FEAT-461's `JSON.parse` path vs. FEAT-465's fallback

No disagreement found. Any double-quoted-only flow-sequence (including one with a
literal `#` inside an entry) is valid JSON and always takes the `JSON.parse` branch
first — `stripComment` already ran on the whole line before `parseScalar` sees it, and
confirmed the `#` survives that (quote-tracking correctly treats a `#` inside double
quotes as content). The manual `splitFlowSequenceEntries` fallback only ever engages
when `JSON.parse` throws (single-quoted or mixed-quote entries) — the two paths are
mutually exclusive by construction (one succeeds or the other runs, never both), so
there's no scenario where they'd disagree on the same input.

## 5. Builder's two design notes — one safe, one caveat

- **Minimal unescaping** (`unescapeDoubleQuoted` only handles `\X -> X`, not full YAML
  double-quote escapes like `\n`): safe as claimed, since `writer.ts` never emits
  double-quoted scalars at all (see #2 above) — this only matters for hand-edited
  input, explicitly out of scope per the FEAT's own non-goal.
- **Flat-only `splitFlowSequenceEntries`**: safe for every real `Config` shape today
  (confirmed only one array field, `customPatterns: string[]`, exists) — but see
  finding in section 3 above: "flat-only" degrades **silently** on the one narrow
  input class (multi-entry nested array via non-JSON fallback) it doesn't handle,
  rather than warning. Low priority given no real field can trigger it today.

## 6. Gates — re-run independently, matches builder's numbers

- `bun vitest run tests/config`: **10 files / 111 tests passed, 0 failed** — matches
  the builder's claimed `111 (10 files)` exactly.
- `bunx tsc --noEmit`: clean, no output.
- `bun run test` (full suite, in-worktree): **198 files / 2367 tests passed, 6
  skipped, 0 failed** — matches the builder's claimed `2367 passed, 6 skipped, 0
  failed, 198 files` exactly.

## Recommendation

Fix Finding 1 before merge — it's a reproducible, silent config-corruption regression
on the daemon's boot path, triggered by an ordinary, realistic input shape (an
unquoted value containing a single apostrophe followed by a real trailing comment),
and it did not exist before this diff. The nested-array silent-degradation note
(section 3) and the minimal-unescaping caveat (section 5) are both real but
low-priority and already substantially disclosed — a follow-up comment or ticket is
enough, not a blocker. Everything else — AC-1 through AC-6's own stated fixtures,
byte-stability for the default-config case, the JSON-vs-fallback cross-check, and
both required gates — is genuinely satisfied and well-tested.

---

## Re-review — fix commit `4459aa7`

### Fix shape, confirmed by diff

`git diff 7a330db..4459aa7 -- src/config/loader.ts`: both `stripComment` and
`splitFlowSequenceEntries` are rewritten so a `'`/`"` only opens quote state at a
position where a new scalar value may legally start — right after the `key:`
separator, or right after a top-level `[`/`,` inside a flow sequence — never at an
arbitrary apostrophe mid-value. `stripComment` now scans the key portion (before the
first `:`) with a separate, quote-unaware pass (matching the old regex's behavior for
that portion, since keys never legitimately contain quotes in this dialect), then
tracks an `atValueStart` flag through the value portion that stays true across
whitespace and after `[`/top-level `,`, and flips false the moment any non-quote,
non-whitespace character is consumed. `splitFlowSequenceEntries` got the identical
treatment via its own `atEntryStart` flag. This directly targets the root cause I
identified in the original review (quote-open must be position-aware, not
triggered by any bare apostrophe) rather than patching around individual repro
strings.

### 1. Original repro + O'Brien variant — re-verified directly, both fixed

```
dataDir: C:\Users\don't\AppData # a trailing comment
  -> { dataDir: "C:\Users\don't\AppData" }   (comment correctly stripped)

dataDir: C:\Users\O'Brien\AppData\Local\Astramem  # moved here 2026-01-01
  -> { dataDir: "C:\Users\O'Brien\AppData\Local\Astramem" }   (comment correctly stripped)
```

### 2. Adversarial attack on value-start detection — no new gaps found

Constructed and ran the following directly against `parseConfigYaml` on the fixed
branch, beyond what the new tests cover:

- **Value that IS a lone quote char** (`key: '`): parses to `{ key: "" }` — the
  unclosed quote consumes to end-of-line, `parseScalar` degrades a bare `'`
  gracefully to an empty string. No crash, no data corruption; a reasonable
  resolution for a degenerate/malformed input.
- **Quote after multiple spaces** (`key:    'v'`, with and without a trailing
  comment): both parse correctly — `atValueStart` correctly survives across
  arbitrary interior whitespace before the opening quote, and the trailing comment
  case still strips correctly (`key:    'v' # comment` → `{ key: "v" }`).
- **Flow entry starting with space then quote** (`[ 'a', 'b' ]`, and `[ 'a #tag',
  'b' ]`): both parse correctly, including the `#` inside the space-prefixed quoted
  entry — `atEntryStart` in `splitFlowSequenceEntries` has the identical
  whitespace-tolerant behavior.
- **Key containing an apostrophe** (`don't_care: value # comment`): parses
  correctly — the key-portion scan (before the first `:`) is quote-unaware by
  design, so an apostrophe there is irrelevant to comment detection, and the
  trailing comment on the value side still strips correctly.
- **Quoted value immediately followed by `#` with no space** (`key: 'v'# comment`,
  and the double-quoted equivalent): the `#` is **not** stripped in either case —
  traced this to the pre-existing (not new) requirement that a `#` must be
  preceded by whitespace or start-of-line to count as a comment delimiter, which
  is unchanged across all three code versions (the original quote-unaware regex,
  round 1's fix, and this round's fix) — not a regression introduced by this
  commit, just a long-standing, consistent design choice I confirmed is unaffected
  by this change.
- **Mixed bare-with-apostrophe entries in a flow sequence**
  (`[don't, 'ok', third]`): parses correctly to `["don't", "ok", "third"]` — no
  interference between an unquoted apostrophe-bearing entry and adjacent quoted/
  bare entries.
- **Unquoted value with an apostrophe and no comment at all** (`note: it's fine`):
  round-trips as the full literal string, as expected.

No case produced silent data corruption, a crash, or an incorrect value. The fix
holds up under adversarial construction, not just against its own five new test
fixtures.

### 3. `splitFlowSequenceEntries`'s round-1 (AC-2) behavior — unaffected

Re-ran the exact FEAT-465 round-1 AC fixtures directly: the mixed-quote-styles-with-
`#` fixture (`["hash #tag no leading space", 'another #value']`), the double-quoted
scalar with `#` (AC-1), the genuine-trailing-comment case (AC-3), and the
trailing-comment-after-closed-quote case (AC-4) all still produce byte-identical
correct results on this commit. The proactive fix to `splitFlowSequenceEntries`
(applying the same position-aware quote-open logic there, even though the original
regression report only demonstrated the bug in `stripComment`) did not alter any of
these previously-passing behaviors.

### 4. Gates, re-run independently

- `bun vitest run tests/config`: **10 files / 116 tests passed, 0 failed** — matches
  the builder's claimed `116/116` exactly.
- `bunx tsc --noEmit`: clean, no output.
- `bun run test` (full suite, in-worktree): **198 files / 2372 tests passed, 6
  skipped, 0 failed** — matches the builder's claimed numbers exactly.

### Validation recommendation (for the merge-gate decision)

This is a pure, deterministic parsing function with no I/O, no external-service
interaction, no timing dependency, and no process boundary — `parseConfigYaml` and
`loadConfigFromDisk` are both directly unit-testable end-to-end (the round-trip
tests already exercise the real `writeConfig` → `loadConfigFromDisk` path, which is
the actual boot-adjacent code path, not a mock of it). Given that plus the
adversarial sweep above finding nothing further, **my recommendation is that the
round-trip/unit-test evidence suffices for this change** — a full boot smoke would
mostly re-confirm what these tests already prove, with low marginal signal, unlike
FEAT-466's keystore work (real OS credential-store interaction, rollback/timing
concerns) where a boot smoke carries much more information. That said, this is
your call as the merge-gate owner; if the team's bar for anything touching
`config.yaml` parsing is "always boot-smoke regardless," a quick `init` +
`serve --port <ephemeral>` + `/health` check with a `#`-bearing, apostrophe-bearing
hand-edited config.yaml would be cheap and directly corroborate this artifact's
findings.

### Final status: PASS

The original HIGH-severity regression is genuinely closed, verified both against
the exact original repros and a broader adversarial sweep of the value-start
detection logic. No new issues found. **w465 is merge-ready** pending your
validation-gate decision above.
