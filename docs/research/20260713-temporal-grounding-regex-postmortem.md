# Temporal-grounding regex postmortem — why PR #257 was closed unmerged (2026-07-13)

Status: **closed, not merged**. `score/ws1-temporal` (PR #257) is dead. This doc exists so
nobody rebuilds the same approach and rediscovers the same failure mode from scratch.

## TL;DR

Deciding whether a phrase like `"last week"` is a free-standing, session-relative time
adverbial or a modifier bound inside a *different* noun's own timeline (`"the project's
last week"`) is a **syntactic** question — it depends on what the phrase attaches to in a
parse tree. Regex has no parse tree. Three separate adversarial validation rounds each
found a new sentence shape that fooled the current guard, and each fix only closed the
specific shape that had just been demonstrated. **There is no round where confidence was
warranted.** The PR was closed rather than pursued to a fourth round, because the
benefit was never measured and the cost of a wrong guard is real: this code rewrites
`atom.text` on every atom the production distill pipeline will ever create — a
confidently-formatted false date written into a real user's memory is indistinguishable
from a correct one and permanent once written.

One genuinely good, general bug fix came out of this work and is documented below so it
isn't lost with the rest of the branch.

## What the PR was trying to do

LoCoMo's temporal question category scored 0.132–0.18 (sample vs. full-run) even on
questions where the harness correctly retrieved the right memory. Diagnosis (the parts of
this work that stand on their own, independent of the regex approach) found: the atom's
`text` field still contained the raw relative-date phrase the source transcript used
("yesterday", "last Friday") uncorrected, because the LLM extraction prompt's own
"resolve this to an absolute date" instruction is not reliably followed by the model in
production. The fix built was a deterministic **post-pass**
(`src/distill/temporal-grounding.ts`, `groundRelativeDates`) that regex-matches known
relative-date phrases in already-extracted atom text and rewrites them to an absolute
date, anchored on the session's own capture date (`sessionDateIso`).

## Round 1 — blocklist, broken by "of"

First shipped version: rewrite `"last week"`/`"next month"`/etc. by default, refuse only
when the phrase was immediately followed by `" of <noun>"` (`"the last week OF THE
PROJECT"` describes the project's own final week, not session-relative time at all).

A live behavior-validation pass (mock LLM providers, real `extractChunk` pipeline, no
GPU) reproduced genuine fabrication in minutes:

```
"Caroline described the last week of the project as extremely stressful."
  -> "...the the week before 15 July 2023 of the project..."
```

A confident, precisely-formatted, completely false claim. Fixed by extending the "of"
block to every `last/next <unit>` pattern (year/month/week/weekend/weekday), not just the
originally-reported cases.

## Round 2 — the blocklist was never going to be enough

A second validation pass broke round 1 in under five minutes with four more
fabrications the `"of"` guard never touched:

```
"The project's last week's numbers were the worst on record."
  -> Saxon genitive ("<referent>'s last <unit>'s...") is the exact syntactic
     mirror of "the last <unit> of <referent>" — just spelled with 's instead of "of".
"It was the war's last year's casualty count that shocked everyone."
  -> same construction, year unit.
"The last week before the launch was chaos."
  -> "before" reaches the identical fabrication "of" was guarding against.
"The last month for the project was rushed."
  -> "for" too.
```

This proved the blocklist was never a sound strategy: enumerating bad prepositions one at
a time cannot converge, because the set of English constructions that re-anchor a
temporal phrase to a different referent isn't a short, closed list.

Fixed by **inverting the whole mechanism to an allowlist**: resolve only when two
independent, positive/negative checks both pass — (1) the phrase must be followed by
end-of-string, a small closed set of clause-ending punctuation, a conjunction, or a
copula/auxiliary verb (the shape that confirms a free-standing adverbial: `"Last week was
rough"`); (2) the phrase must NOT be immediately preceded by another noun's possessive
marker (`"project's last week"`). A trailing possessive (`"last week's numbers were
bad"`) — previously allowed on the theory it never changes the referent — was reversed:
round 2 proved that reasoning false the moment something *else* precedes it, and
special-casing "possessive is safe only when nothing precedes it" would just be the same
blocklist shape wearing a different hat.

Verified coverage against the 22 real LoCoMo cases this module was originally diagnosed
against dropped from 20/22 (91%, round-1 blocklist) to 18/22 (82%, round-2 allowlist) —
**reported honestly and not chased back up**, since the two lost cases (`"last week"`
followed by `"with"`/`"about"`) would have required re-permitting exactly the class of
construction that had just been closed (`"the last week WITH the old team"` is the
identical fabrication shape with a different preposition).

## Round 3 — pronoun possessives, the shape that killed the PR

A third validation pass found the possessive guard only matched a literal noun + `'s`
(`project's`, `war's`) — not a pronoun possessive:

```
"Her last week was overwhelming."   -> "Her the week before 15 July 2023 was overwhelming."
"Its last year was brutal."         -> "Its 2022 was brutal."
"His last Friday was emotional."    -> "His 14 July 2023 was emotional."
"Their last week was quiet."        -> "Their the week before 15 July 2023 was quiet."
```

`her/his/its/their/my/your` possessives were never in the (fixed-length) lookbehind's
character set. This is not an obscure corner case — **it is how ordinary biographical
narration works**, the exact register both LoCoMo transcripts and real user
conversation-memory text are written in. It hit every unit type. A secondary break was
also found: an adjective interposed between the possessive and the unit (`"the team's
exhausting last month"`) defeats a fixed-length lookbehind by construction, since the
possessive is no longer immediately adjacent to the phrase.

## The structural conclusion

Three rounds, three different sentence shapes, three guard mechanisms (blocklist →
allowlist → allowlist + broader pronoun set would have been round 4). **Each fix closed
exactly what had just been demonstrated and nothing more** — a genuine part-of-speech/
attachment question was being answered by enumerating counterexamples one adversarial
round at a time, which is not a process that converges. Round 4 would have found `"the
last week I saw her"` or some other shape neither guard anticipates; there is no round
after which the module could be trusted without another adversarial pass finding the
next one.

**If this needs to be built for real, it needs an actual parser** (or at minimum a POS
tagger) to determine what a candidate temporal phrase syntactically attaches to — a regex
lookaround, however cleverly constructed, is fundamentally the wrong tool for a question
that depends on sentence structure rather than local token patterns.

## Why closing was the right call, not just a acceptable one

- **The benefit was never measured.** No LoCoMo eval ever ran against any version of this
  branch (GPU was unavailable throughout — see issue #251). Every coverage number in this
  doc and the closed PR is a static measurement against 22 real atom texts, not a score
  delta.
- **#262 merged separately** and independently fixes the dominant real-world failure mode:
  the extraction prompt itself instructs the model to emit ISO-8601 dates
  (`"2023-05-14"`), which LoCoMo's own token-F1 scorer treats identically to an unresolved
  relative phrase (both score 0 — punctuation stripping collapses the ISO date to one
  glued digit token with zero overlap against a prose-formatted gold answer). This
  post-pass only ever fires on phrases the *model* left unresolved; a compliant model
  emitting ISO per the (buggy, now-fixed) prompt got zero benefit from this branch either
  way. #262 plausibly captures most of the real upside this branch was chasing, without
  touching atom text after the fact at all.
- **The temporal ceiling itself is in doubt** — see issue #267: the retrieval diagnostic
  tool used to establish temporal-category ceilings has a measured 42% false-negative
  rate, meaning several of the numbers this workstream was sized against are
  contaminated and due for re-measurement before any further temporal-specific
  investment is funded.
- **The cost is not symmetric with the benefit.** A missed resolution leaves an honest,
  slightly-vague phrase in a memory. A fabrication writes a confident, correctly-formatted
  falsehood into a real user's permanent memory store, indistinguishable from a genuinely
  grounded date, with no way for the user to ever discover it's wrong. Three fabrication
  rounds against an unmeasured, narrow-slice (16.2% of the benchmark) benefit does not
  clear that bar.

## What to keep — a real, general bug fix

`addMonthsUtc`'s original implementation (`src/distill/temporal-grounding.ts`, now dead
code) had a genuine, generalizable bug worth remembering independent of this module's
fate:

```ts
// BROKEN — do not reintroduce this shape anywhere in the codebase:
function addMonthsUtc(anchor: Date, months: number): Date {
  const d = new Date(anchor.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);   // <-- overflows forward
  return d;
}
```

`Date.prototype.setUTCMonth` on a `Date` still carrying the **anchor's own day-of-month**
silently overflows forward whenever that day doesn't exist in the target month — e.g. an
anchor of `2023-07-31` asking for `+1 month` lands on the nonexistent `"2023-08-31"`,
which JS `Date` normalizes into `2023-09-XX` **instead of throwing**. Concretely: `2023-07-31`
+ "last month" resolved to `"July 2023"` — the *same* month, not June — and `2023-03-31` +
"next month" resolved to `"May 2023"`, skipping April entirely. The bug shipped invisibly
behind 307 previously-green tests because the entire test suite anchored on the 15th of
some month, the one day-of-month that can never trigger the overflow.

**The fix, if this pattern is ever needed again**: when only month/year granularity is
required (day-of-month is going to be discarded anyway), construct the 1st of the target
month directly via `Date.UTC`, so there is no day-of-month value left to overflow:

```ts
function addMonthsUtc(anchor: Date, months: number): Date {
  return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + months, 1));
}
```

**Generalizable lesson**: any month-arithmetic helper anywhere in this codebase that uses
`setUTCMonth`/`setMonth` on a `Date` still carrying a day-of-month greater than 28 is a
candidate for this exact silent-overflow bug. If a similar helper needs to be written
elsewhere, prefer `Date.UTC(year, month, day)` constructed fresh over mutating an existing
`Date`, and test explicitly against month-end anchors (29th/30th/31st) — a test suite
anchored only on mid-month dates cannot detect this class of bug regardless of how many
tests it has.

## Evidence trail

- Closed PR: [#257](https://github.com/astragenie/astramem-local/pull/257) — full
  round-by-round detail, every repro case, every coverage measurement, in the PR body and
  commit history (`828510a` diagnosis → `59bb4d7` final allowlist attempt).
- Sibling PR, merged: [#262](https://github.com/astragenie/astramem-local/pull/262) — the
  ISO-8601 extraction-prompt fix.
- Open issue: [#267](https://github.com/astragenie/astramem-local/issues/267) — retrieval
  diagnostic false-negative rate, the reason temporal ceilings cited in this doc and in
  #257 need re-measurement before further investment.
- Original diagnosis: `docs/specs/20260713-locomo-score-plan.md` §1 (temporal headroom
  estimate this workstream was chasing — treat the +7 point figure there as retired by
  this postmortem).
