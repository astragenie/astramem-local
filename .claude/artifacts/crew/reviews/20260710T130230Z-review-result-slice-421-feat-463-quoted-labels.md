---
status: PASS
---

# Review Result — SLICE-421 / FEAT-463 (stage-0 redaction: quoted/JSON label forms)

- Branch: `feat/feat-463-quoted-labels` (commits `fab5173` fix, `07cc8ea` handoff,
  `32db526` fix-round 1, `9534cd8` handoff update, `963613d` fix-round 2, `6d18873`
  handoff update), vs `main`/`969db7a`
- Reviewer: independent adversarial review (read-only, no edits made)
- **Original verdict: NEEDS_FIX** (below) — **Re-review after `32db526`: NEEDS_FIX
  again** (suffix-attack variant found) — **Final re-review after `963613d`: PASS**,
  with one pre-existing, orthogonal, out-of-scope entropy-detector limitation
  documented (not a regression from this diff). See both re-review sections at the end.
- Everything else in the diff (the 6 new quoted detectors,
  AC-1 through AC-6, structural non-overlap, ReDoS) checks out.

## 1. `entropy.ts` guard — CRITICAL bypass, reproduced against the real code

**Finding (HIGH/CRITICAL — file:line `src/redact/entropy.ts:51-52,96`): a real, high-entropy
secret can be constructed to defeat all three redaction stages simultaneously, simply by
containing a recognized keyword substring and ending in a bare `:` or `=` with no separator
character between the keyword and the rest of the value.**

The new guard:
```
const LABEL_ONLY_RE = /^["']?[A-Za-z][A-Za-z0-9_]*["']?[:=]$/;
const SECRET_LABEL_KEYWORD_RE = /(?:api[_-]?key|secret|token|password|passwd|pwd)/i;
...
if (LABEL_ONLY_RE.test(token) && SECRET_LABEL_KEYWORD_RE.test(token)) return true;
```
suppresses entropy detection on any whitespace-delimited token that is *entirely* letters/
digits/underscores (plus optional surrounding quotes) and ends in `:` or `=`, **if** it also
contains one of the keyword substrings anywhere. The design intent (per the code comment) is
narrowly "a label with no value attached" (e.g. `"PASSWORD_MIN_LENGTH":` glued to nothing) —
but the regex doesn't actually verify there's no value; it only checks the token's own shape.
A token that is genuinely a **secret value** (not a label) can satisfy the exact same shape if
it happens to (a) be built only from letters/digits/underscores, (b) contain a keyword
substring anywhere in its own characters, and (c) end in a bare `:` or `=` glued directly on
with no separator in the middle (common for base64 padding, or any value a user/system
concatenated a trailing punctuation mark onto).

**Reproduced directly against the actual code** (`shannonEntropy`, `findEntropySecrets`,
`redactText` — no mocking):

| input | entropy (bits/char) | length | pattern detectors fire? | entropy stage fires? | leaked? |
|---|---|---|---|---|---|
| `mysecrettoken1234567890abcdef=` | 4.507 (>4.0 threshold) | 30 (>20 floor) | no | **no (suppressed)** | **YES — full plaintext in output** |
| `mysecrettoken1234567890abcdef:` | 4.507 | 30 | no | **no (suppressed)** | **YES** |
| `my_secret_token_9f8a7b6c5d4e3f2a1b0c=` | 4.520 | 37 | no | **no (suppressed)** | **YES** |
| control: `myrandomvalue1234567890abcdef=` (same shape, no keyword) | 4.548 | 30 | no | **yes, correctly flagged** | no (redacted as `high_entropy`) |

The control row proves the keyword-substring check is precisely what causes the bypass — an
otherwise-identical high-entropy token with no keyword substring is correctly redacted;
add "secret"/"token" anywhere inside it and it passes through every stage untouched. None of
the 8 `PATTERN_DETECTORS` entries (old or new) fire on these tokens because the recognized
keyword is never immediately followed by a separator (the separator is glued to the *end* of
the token, after additional value-like content, not right after the keyword) — this shape
falls through the pattern-detector stage by construction and was always meant to be caught by
the entropy fallback, which this diff's own new guard now defeats.

Why this is a realistic, not merely theoretical, shape: base64-encoded secrets commonly end in
`=` padding; many bespoke/internal API tokens are literally named with the word "token" or
"key" baked into the value itself (not just the label) as a vendor-naming convention (mirrors
how `ghp_`/`xoxb-`/`sk-` prefixes work for the vendor-specific detectors, just without a
registered vendor pattern). `SECRET_LABEL_KEYWORD_RE` is case-insensitive and substring-based
(no word-boundary requirement), so any casing and any position within the token triggers it.

**No existing test exercises this class** — confirmed via `grep -n "LABEL_ONLY_RE\|
SECRET_LABEL_KEYWORD_RE" tests/security/*.ts` returning zero matches. This is a genuinely new
blind spot introduced by this diff (the guard is 100% new code, not a pre-existing gap) — it
is not present on `main`/`969db7a` (the old `entropy.ts` has no equivalent guard; the same
tokens would have correctly cleared `CONFIG_ASSIGNMENT_RE`, which requires the value to be
literally `\d+|true|false` glued to the label, not an arbitrary blob, and would have been
flagged as `high_entropy`).

**Recommended fix direction (not prescriptive — builder's call):** the guard's actual intent
is narrower than what it currently implements — it should only suppress a token that is
*genuinely a value-less label* (nothing follows it that could be the value), not merely
"shaped like an identifier and containing a keyword." Options: (a) only apply the guard when
the token is the last token in the text, or is followed by a short next-token that is itself
numeric/boolean/quoted (replicating the exact `"PASSWORD_MIN_LENGTH": 8` split-token shape the
guard was built for, using the `text`/`start`/`end` context `isGuarded` already receives), or
(b) require the keyword to be an exact, whole underscore-delimited segment of the identifier
(not merely a substring) as a partial mitigation — note this alone does **not** fully close the
gap (the underscore-variant reproduction above, `my_secret_token_...=`, already has the keyword
as a clean delimited segment and would still bypass), so (a) or an equivalent context-aware
check is the safer path. This needs a fix before merge — it's a silent, exploitable secret-leak
regression in the exact file the team lead flagged for highest scrutiny.

## 2. New quoted detectors — edge-case sweep

Tested directly against the real `redactText`, not just by reading the regex:

- **Escaped quotes inside a JSON value** (`"api_key": "sk-abc\"def"`): the double-quote-value
  regex (`"([^"]*)"`) has no escape awareness, so it captures only up to the *literal* escaped
  quote character (`sk-abc\`, including the stray backslash) and redacts that — the remainder
  of the value (`def`) is left in plaintext immediately after the placeholder. **MEDIUM,
  disclosed**: this is explicitly called out in the builder's own handoff ("Risks / open
  questions": "nested/escaped-quote values ... regex-tier only, per the FEAT's stated
  non-goals") and matches the FEAT's own non-goal ("full JSON/YAML AST walking"). Not a hidden
  gap, but worth a code comment at the regex site itself (not just the handoff doc) since a
  *partial* redaction that looks fully redacted is a more dangerous failure mode than a
  complete miss — recommend as a fast-follow, not a blocker given it's disclosed and
  explicitly out of scope.
- **Mixed/mismatched quote types** (`"DB_PASSWORD': hunter2222222`): matches and redacts
  correctly. The detector doesn't track matching quote pairs (by design — it isn't a real
  parser), so a malformed/mismatched quote still triggers correctly. Not a bug.
- **Keyword case variants** (`API_KEY`, `Api_Key`): both redact correctly — the `i` in the
  `'id'` flags is doing its job.
- **Unicode "smart" quotes** (`"..."` U+201C/U+201D): not recognized by the quoted detectors
  (ASCII-only `"`/`'` in the regex) — falls through to the entropy stage. For a **long**
  secret this still gets caught (as `high_entropy`, confirmed). For a **short** secret (under
  the 20-char entropy floor), it is a **total, unredacted leak** — confirmed:
  `"API_KEY": "short1"` (unicode quotes) passes through completely unchanged, while the ASCII
  equivalent `"API_KEY": "short1"` correctly redacts via the label match (no length floor).
  **LOW-MEDIUM, not blocking**: unicode quotes aren't in the FEAT's stated scope (JSON/PHP
  ASCII-quote forms only), and this is a narrower, pre-existing-shaped gap (arguably belongs
  in the same "not full AST parsing" non-goal bucket) — flagging for a possible follow-up
  since transcripts pasted from smart-typography sources (word processors, some chat UIs) are
  a plausible source of curly quotes.
- **Multiple credentials on one line**: both redact independently and correctly, no
  interference, no double-redaction.
- **Trailing punctuation/comma swallow**: for the **quoted-value** entries, the comma is
  correctly preserved outside the redaction (`"api_key": "sk-...",` → `"api_key":
  "[REDACTED:...]",` — comma intact). For the **bare/unquoted-value** entries (both trailing
  and compound), the greedy `\S+` value capture *does* swallow a trailing comma (`"api_key"=sk-
  abc,` → `"api_key"=[REDACTED:...]` — comma gone). **Verified this is pre-existing, not a
  regression**: the untouched, original `generic_credential` unquoted entry (`detectors.ts:132`)
  has the identical `\S+` capture and swallows the same trailing comma on `main` — confirmed by
  testing `api_key=sk-abcdef1234567890,` directly, same behavior. Not a new issue from this
  diff, not blocking.

## 3. Structural non-overlap claim — verified

Confirmed both by regex analysis and empirical testing: the unquoted `generic_credential`
entries require `\s*[:=]` to match immediately after the keyword (only whitespace, never a
quote character, can appear before the separator), while every new quoted entry requires a
mandatory `["']` immediately before the separator. These are mutually exclusive at any given
starting position — a quote character between keyword and separator can satisfy at most one
family, never both. Verified empirically on `"secret_key": "value"` (only the new quoted entry
fires; the old unquoted compound entry correctly does not, since a `"` — not whitespace —
follows the keyword). No double-redaction or nested-placeholder artifact observed in any test,
including the multi-credential-per-line case above.

## 4. AC-4 (no regression to existing tests) — verified, not just claimed

`git diff 969db7a..fab5173 -- tests/security/redact.test.ts | grep -c '^-[^-]'` → **0** — the
diff to the test file is a pure addition, zero lines removed or altered. Matches the builder's
claim exactly.

## 5. ReDoS check — clean

Tested the compound-label `(?:_[A-Za-z0-9]+)+` shape (the closest thing to a classic nested-
quantifier ReDoS pattern in this diff) against several adversarial payloads designed to force
maximal backtracking (long underscore-alnum chains with no valid terminator, up to 5000 chars
with a stray quote at the very end): all completed in under 3ms, including a ~4400-char
50x-repeated adversarial payload. No exponential blowup — expected, since `_` and
`[A-Za-z0-9]` are disjoint character classes, so there's no ambiguity in how the repeated group
partitions matched text (the structural precondition for catastrophic backtracking isn't
present here).

## 6. Gates — re-run independently, matches builder's numbers

- `bunx tsc --noEmit`: clean, no output.
- `bun vitest run tests/security`: **6 files / 113 tests passed, 0 failed** — matches the
  builder's claimed `6 files / 113 tests passed, 0 failed` exactly.

## Recommendation

Fix Finding 1 (the `entropy.ts` guard bypass) before merge — it's a reproducible, silent
under-redaction of a real secret shape in a security-critical path, and it's newly introduced
by this diff's own "unplanned" change, not inherited. Findings on escaped-quote partial
redaction and unicode-quote total-leak-for-short-secrets are real but lower severity and
already substantially disclosed as regex-tier/non-AST-parsing limitations — recommend a
fast-follow FEAT or at minimum an inline code comment at the escaped-quote capture site, not a
blocker. Everything else — the 6 new quoted detectors' AC-1/AC-2/AC-3/AC-5 coverage, AC-4's
pure-addition guarantee, AC-6's perf budget, structural non-overlap, and ReDoS safety — is
genuinely satisfied and well-tested.

---

## Re-review — fix commit `32db526` (entropy bypass fix round)

### Fix shape, confirmed by diff

`git diff fab5173..32db526 -- src/redact/entropy.ts`: the naive `LABEL_ONLY_RE &&
SECRET_LABEL_KEYWORD_RE` check is replaced by `isLabelWithSafeValueFollowing(token, text, end)`
— it still requires the token to be shaped like a keyword-bearing label, but now ALSO requires
a genuinely safe value (pure digits, or `true`/`false`, optionally with one layer of
surrounding quotes stripped) to be the very next whitespace-delimited token in the text. A
label-shaped token with nothing safe following — including nothing following at all, which is
exactly the shape of the three original repros — now falls through to ordinary entropy
scoring. The builder's own new code comment explicitly anticipates and discloses the residual
this re-review targets: "an attacker who deliberately appends a short numeric/boolean token
after a crafted secret could still exploit this exact split-token shape."

### 1. Suffix attack — reproduced, confirmed leaking

Ran directly against `redactText` on the fixed branch. Appending a safe-shaped value
immediately after each of the three original bypass tokens revives the exact same leak,
just relocated from the token's own shape to the token-*pair*'s shape:

| input | redacted? |
|---|---|
| `mysecrettoken1234567890abcdef= 8` | **no — leaks in full** (`events: []`) |
| `mysecrettoken1234567890abcdef= true` | **no — leaks in full** |
| `mysecrettoken1234567890abcdef: 8` | **no — leaks in full** |
| `my_secret_token_9f8a7b6c5d4e3f2a1b0c= 42` | **no — leaks in full** |
| `mysecrettoken1234567890abcdef= "8"` (quoted safe value) | **no — leaks in full** |
| `mysecrettoken1234567890abcdef= "true"` (quoted safe value) | **no — leaks in full** |

This is the same severity class as the original finding — a real, high-entropy secret token
(4.5+ bits/char, well over both the 4.0 threshold and the 20-char floor) silently passes
through all three redaction stages unredacted, purely because a short digit/boolean token
happens to follow it. **This is confirmed to still leak — needs_fix, per the same
under-redaction severity logic as the original finding.**

That said, two things are materially different from the original finding, worth weighing
honestly rather than treating this as identical in every respect:

- **Trigger surface is narrower.** The original bug fired on the secret token alone, no
  coordination with surrounding text required. This variant requires a *second*, adjacent
  coincidence (the very next whitespace-delimited token must independently look like a bare
  digit or boolean) — for **accidental** (non-adversarial) triggering, a real secret sitting
  immediately next to an unrelated bare `8`/`true`/`false` token with nothing else between them
  on the same line is a much rarer coincidence than the original all-in-one-token shape. For a
  **deliberate adversarial** actor who knows this redactor's implementation (plausible in an
  agentic context — a compromised tool/MCP response deliberately shaping its own output to
  evade a known-open-source redaction heuristic), it's trivially exploitable either way.
- **It's disclosed, not silent.** The new code comment names this exact residual and its cause
  in the source itself (not just a handoff doc), and correctly identifies that a fix along the
  lines I originally suggested (next-token-context checking) carries the identical limitation
  — any heuristic that classifies "label vs. value" purely from adjacent-token *shape*, without
  real semantic understanding of intent, is fundamentally gameable by construction. Closing
  this completely likely requires abandoning "trust nearby token shape" as the mechanism
  entirely (e.g., only ever suppressing entropy for a value-less label when it's provably the
  *last* token in the text, with no shape-based next-token trust at all — accepting that the
  original `"PASSWORD_MIN_LENGTH": 8`-style false positive would then need a different fix, or
  be accepted as a known, narrower false-positive residual instead).

Recommendation: given the team's explicit severity policy for this review round, this should
be treated as needs_fix rather than accepted silently — but note in the fix-round handoff (or
promote to a decision-log entry) that full closure may require dropping the next-token-shape
heuristic rather than tightening it further, since the residual is structural to this class of
heuristic, not an implementation oversight.

### 2. Multi-token lines — independent redaction still holds

`PASSWORD_MIN_LENGTH: 8 mysecrettoken1234567890abcdef=` (a real AC-3 false-positive fixture
immediately followed, on the same line, by an unrelated bare secret with nothing safe after
it): the `PASSWORD_MIN_LENGTH: 8` pair correctly stays unredacted, and the separate secret at
the end of the line — which has nothing following it — correctly still redacts as
`high_entropy`. Confirms the fix doesn't regress the legitimate multi-token case when the
attack shape isn't present.

### 3. Quoted safe-value boundary — verified correct on its own terms

`"SECRET_SCAN_ENABLED": "true"` (the actual AC-3 fixture, keyword+quote+colon all directly
adjacent, no space) is handled entirely by the pattern-detector stage, not the entropy guard —
confirmed unredacted as before, no regression. Constructed the boundary case that actually
exercises the entropy guard specifically (a label-shaped token, space, then a *quoted*
next-token, which is the shape the pattern detectors don't reach): a quoted non-numeric value
(`mysecrettoken1234567890abcdef= "8chars00"`) correctly does NOT trigger the guard — the
secret-shaped token is still redacted as `high_entropy` in that case, only the trailing quoted
value is left alone. Quoted `"8"`/`"true"` do trigger it (per the suffix-attack table above).
So `SAFE_VALUE_RE`'s quote-stripping is working exactly as designed — the boundary is correct
in isolation; the vulnerability is that the design itself (trust the next token's shape at all)
is what's gameable, not a bug in the boundary check.

### 4. Original 3 repros + control — re-verified directly, not trusted from the report

Ran all four again on this branch with no suffix: all three original bypass tokens now
redact correctly as `high_entropy`, and the no-keyword control still redacts as before (no
regression there). The 4 new tests in `tests/security/redact.test.ts` (`git diff
fab5173..32db526`) are exactly these four cases, added as `TRUE_POSITIVES` fixtures — matches
what's claimed, and none of the 4 new tests cover the suffix-attack shape, confirming the gap
found here has zero existing test coverage.

### 5. Gates, re-run independently

- `bun vitest run tests/security`: **6 files / 117 tests passed, 0 failed** — matches the
  builder's claimed `117/117`.
- `bunx tsc --noEmit`: clean, no output.

### Final status: NEEDS_FIX

The original CRITICAL bypass is genuinely closed for the exact three repros and the general
"isolated keyword-shaped token" class. A new, narrower variant of the same under-redaction
class was found and reproduced by attacking the fix's own next-token-trust mechanism, per this
round's explicit instruction. Recommend either: (a) another fix round that removes
shape-based next-token trust entirely (accepting a possible reopening of the original
split-token false-positive, to be re-scoped), or (b) an explicit, product/security-owner-signed
decision-log entry accepting this narrower residual risk as a documented limitation of a
regex-tier heuristic (distinct from silently shipping a known gap in a code comment alone) —
either resolves this round; simply re-disclosing in a code comment without one of these two
does not, per the same severity bar applied to the original finding.

---

## Final re-review — fix round 2, commits `963613d` + `6d18873`

### Fix shape, confirmed by diff

`git diff 32db526..963613d -- src/redact/entropy.ts`: the guard is now three-layered. The
label's identifier text (quotes/separator stripped — the "core") must satisfy ALL of: (1) a
genuinely safe value (digits/boolean, optionally quoted) immediately follows — round 1's check,
kept; (2) the core's OWN Shannon entropy is below the configured threshold — this is the layer
that closes the suffix attack, since it doesn't depend on trusting anything adjacent to the
token; (3) the core is either short (< `MIN_TOKEN_LENGTH`) or doesn't have a hex/base62-like
case profile (`HEX_LIKE_MIX_RE`, a lowercase-letter-adjacent-to-digit check), a belt-and-
suspenders layer. A keyword-shaped token failing any one of the three falls through to the
ordinary per-token entropy check, same as any other text.

### 1. Entropy table — spot-checked directly, matches exactly

Computed via `shannonEntropy()` from the real module, not trusted from the commit message:
`PASSWORD_MIN_LENGTH` → 3.932 (claimed 3.932), `DJANGO_SECRET_KEY` → 3.690 (claimed 3.690),
`OPENAI_API_KEY` → 3.093 (claimed 3.093), and the bypass core `mysecrettoken1234567890abcdef`
→ 4.444 (claimed 4.444). All four match exactly — the numbers in the code comment and commit
message are real computed values, not asserted ones.

### 2. Original repros, suffix-attack shapes, and AC-3 negatives — all re-verified directly

Ran all of the following against the real `redactText` on this branch (not trusted from the
report):

- **3 original repros + control** (no suffix): all 4 still redact as `high_entropy`, unchanged
  from round 1.
- **6 suffix-attack shapes** (the exact ones this re-review round targets — bare/quoted
  digit/boolean decoys after each of two repro variants): **all 6 now correctly redact as
  `high_entropy`.** The round-1 leak (`events: []`) is closed in every case tested, including
  the quoted-decoy variants (`...= "8"`, `...= "true"`).
- **AC-3 negatives**: `"PASSWORD_MIN_LENGTH": 8`, `"SECRET_SCAN_ENABLED": "true"`, and their
  unquoted equivalents all correctly stay unredacted (`events: []`) — no new false positive
  introduced by the layered guard.
- **Multi-token line** (legit label:value pair followed by an unrelated trailing secret with
  nothing after it): still redacts the trailing secret independently, unaffected.

### 3. Layer-2 attack (digit-heavy/low-alphabet candidates) — investigated, does NOT reopen a bypass in this guard

Constructed exactly the candidate class asked for: `token12345678901234567890=` (25-digit core
after "token") and a lower-diversity repeated-digit variant. Both **do leak** — but critically,
**both leak identically with or without a decoy suffix appended**, and a **completely bare,
unlabeled, keyword-free digit string of the same digit density** (`98765432109876543210987654`
— no "token", no trailing separator, no relationship to any guard at all) **also leaks**, at
entropy 3.295.

This is decisive: the leak is not caused by anything this guard does or fails to do. A
digit-heavy token's raw Shannon entropy tops out around `log2(10) ≈ 3.32` bits/char for
uniformly-distributed digits — well under the 4.0 default threshold — so the entropy detector
was **never going to flag it**, guard or no guard, label-shaped or not, decoy or not. This is a
pre-existing, orthogonal limitation of using a fixed Shannon-entropy threshold over a
variable-size alphabet (a 10-symbol numeric alphabet has a much lower entropy ceiling than a
62-symbol alnum one) — it predates this FEAT entirely and is not introduced, worsened, or even
touched by either fix round's label-guard logic. Confirmed empirically that a numeric secret
with a REAL adjacent separator and keyword (e.g. `TOKEN=1234567890123456789012345`, a labeled
form) is still caught correctly regardless — by the pre-existing `generic_credential` pattern
detector (no entropy involved at all, and no `valueFilter` on the trailing-keyword entry), so
the practical exposure is narrower still: it only bites a numeric secret that is BOTH unlabeled
by any recognized keyword-adjacent-separator pattern AND has no other vendor-specific signature.

**Severity call: not blocking, not a finding against this diff.** This is an existing,
independent gap in the entropy detector's fundamental design (small-alphabet content has an
inherently low entropy ceiling relative to the fixed 4.0 threshold), not a bypass of the
layered label-guard this review round was scoped to verify. It doesn't belong in this FEAT's
scope, and closing it would require a different mechanism entirely (e.g. an
alphabet-size-aware threshold, or a minimum-length floor tuned differently for narrow-alphabet
tokens) — a reasonable candidate for a separate backlog item, not a gate on this slice.
Recommend a one-line note in `entropy.ts`'s file-level doc comment acknowledging the
known numeric-secret blind spot (parallel to the existing `MIN_TOKEN_LENGTH` design-point
comment), but this is a nice-to-have, not required for PASS.

### 4. Git hygiene — verified clean

`git show --stat 963613d`: only `src/redact/entropy.ts` (118 changed lines) and
`tests/security/redact.test.ts` (50 added lines) — no backlog/state files. `git show --stat
6d18873`: only the handoff doc. `git diff fab5173..6d18873 --stat -- .claude/`: only the one
handoff-doc file across the entire fix-round span (346 insertions, one file) — confirms the
builder's reported near-miss with `reset --soft` did not leave any backlog/workflow-state
drift in the committed history on this branch. (Uncommitted working-tree churn visible via
plain `git status` — modified/deleted loop bookkeeping files — is unrelated background loop
state from the ambient session, not part of these two reviewed commits.)

### 5. Gates, re-run independently

- `bun vitest run tests/security`: **6 files / 124 tests passed, 0 failed** — matches the
  builder's claimed `124/124`.
- `bunx tsc --noEmit`: clean, no output.

### Final status: PASS

The original CRITICAL entropy-guard bypass and its round-1 suffix-attack variant are both
genuinely closed, verified by direct reproduction against the real code rather than by trusting
either report. The one residual investigated at this round's request (digit-heavy/low-alphabet
secrets) is confirmed to be a pre-existing, guard-independent limitation of Shannon-entropy
detection over a narrow alphabet — present with or without any of this FEAT's changes, and
narrowed further in practice by the pre-existing pattern-detector coverage for labeled numeric
secrets. Recommend filing it as a separate, low-priority backlog item (entropy detector's
numeric-secret blind spot) rather than gating this slice on it. All other findings from the
original review (escaped-quote partial redaction, unicode-quote total-leak-for-short-secrets,
pre-existing trailing-comma swallow) remain as previously assessed: real but disclosed/low
severity, not blocking.

---

## Micro re-check — commit `55af87e` (validator-found `=>` arrow double-match, +`a171a2b` handoff)

`git diff 6d18873..55af87e -- src/redact/detectors.ts`: `QUOTED_LABEL_SEP`'s alternation
changes from `(?:=>|[:=])` to `(?:=>|:|=(?!>))` — a single shared constant, so all 6 quoted
entries get the fix uniformly. Root cause (regex backtracking, not a logic error in the
original intent): on `'DB_PASSWORD' => 'hunter2xx'`, the *sibling* bare-value entry tried `=>`
first, failed past it (the real value is quoted, so the bare-value pattern's `(?!["'])` guard
rejects it), then backtracked the alternation down to plain `[:=]`, consumed only the `=`, and
captured the leftover `>` as a bogus one-character match — corrupting the arrow in the output
and inflating the event count, while the primary quoted-value entry still correctly redacted
the real secret. `=(?!>)` closes it: a bare `=` is only permitted when NOT immediately followed
by `>`, so when it is, the only legal consumption path is the whole `=>` alternative, which the
bare-value sibling then correctly fails to match at all (real value is quoted) — zero spurious
match, exactly the intended behavior.

**Edge probe (asked: can `=(?!>)` reject a legitimate bare-`=` form?):** constructed and ran
directly against `redactText`: (a) `'DB_PASSWORD'=>weird` (arrow immediately followed by an
unquoted value) — correctly treated as a genuine arrow, single event, `weird` redacted whole;
this is the intended, unambiguous PHP-array reading of that token sequence, not a corruption.
(b) `'DB_PASSWORD' = >weird` (bare `=`, then a SPACE, then a value that itself starts with `>`)
— `=(?!>)`'s lookahead only inspects the character immediately following `=`; since that's a
space here, not `>`, the bare `=` matches normally and `>weird` is captured whole as the value,
single event, no corruption. (c) Two regression checks (genuine arrow with a quoted value and
with a bare value) both still produce exactly one event with the arrow byte-intact. Found no
case where the guard incorrectly rejects a legitimate bare-`=` — the lookahead is narrow enough
(single next-character check) that it only ever intercepts the one truly ambiguous shape
(`=` directly abutting `>`), which is correctly resolved as the arrow.

**Event-count assertion:** confirmed `expectedEventCount?: number` on `TruePositiveCase`
(`tests/security/redact.test.ts`) defaults via `expect(events.length).toBe(expectedEventCount ??
1)` inside the shared `it.each(TRUE_POSITIVES)` loop — applies to every fixture in the table,
old and new alike, not just the 6 new arrow-sweep cases. This closes the exact blind-spot class
the bug exploited (a placeholder-presence-only check can't see a spurious *extra* match riding
alongside a correctly-redacted secret) permanently, for the whole suite, not just this bug's own
repro.

**Validator's exact repro, re-run directly:** `'DB_PASSWORD' => 'hunter2xx'` → exactly 1 event
(`generic_credential_quoted`), output `'DB_PASSWORD' => '[REDACTED:generic_credential_quoted:
2ceb5811]'` — arrow (`=> '`) byte-intact, matches what's now pinned by
`tests/security/redact.test.ts`'s dedicated `redactText — PHP array-arrow (=>) output
integrity` describe block.

**Gates, re-run independently:** `bun vitest run tests/security` → **6 files / 132 tests
passed, 0 failed** (up from 124, the +7 new/expanded fixtures — matches builder's claim once
event-count assertions are counted per-fixture, not as separate tests). `bunx tsc --noEmit` →
clean, no output.

### Status: confirmed PASS through `55af87e` / `a171a2b`

No regressions found in this micro re-check. The arrow double-match is a genuine, narrow
correctness fix (MEDIUM, as filed) with no new edge-case gaps introduced, and the
`expectedEventCount` mechanism is a durable, suite-wide improvement to this test file's
detection power, not a one-off patch. **PASS covers the branch through `55af87e`/`a171a2b`** —
clear to merge and close the slice.
