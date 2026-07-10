---
id: FEAT-463
status: done
priority: P1
category: security
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: [FEAT-459]
slices: [SLICE-421]
derived_from: .claude/artifacts/crew/reviews/20260710T082304Z-review-result-feat-459-redaction.md
cross_product: [astramem-local]
pm_user_value: 0.5
pm_strategic_fit: 0.65
pm_effort_inverse: 0.8
pm_risk_inverse: 0.75
pm_confidence: 0.85
composite_score: 0.71
composite_priority: P1
autonomous_safe: true
triaged_at: 2026-07-10
started_at: 2026-07-10
slices_complete: [SLICE-421]
completed_at: 2026-07-10
---
## Description

**Stage-0 redaction: quoted/JSON label forms not detected** — the
generic_credential detector requires the `=`/`:` separator to immediately
follow the label keyword (whitespace only). Quoted label forms produce no
match:

- `"OPENAI_API_KEY": "sk-abc..."` (JSON config pasted into a transcript)
- `'DB_PASSWORD' => 'hunter2'` (PHP array syntax)
- `SECRET_KEY = "value"` where the closing quote of a quoted LABEL breaks
  adjacency (`"SECRET_KEY"=...`)

JSON-shaped config is a common transcript payload (agents echo config files,
.env-to-JSON conversions, API responses). Pre-existing gap — found during the
FEAT-459 review (non-blocking there, tracked here).

### Scope
- Extend the label-side pattern to tolerate closing quote/apostrophe between
  keyword and separator, and quoted values (`"sk-..."` — redact inside the
  quotes, preserve the quotes for structural validity of surrounding JSON).
- Same two-tier precision design as FEAT-459 (high-precision keywords
  any-segment; ambiguous keywords trailing-only; numeric/boolean value guard).
- Positive fixtures for JSON/YAML/PHP-array shapes; negative fixtures for
  benign quoted config (`"NODE_ENV": "production"`, `"PORT": "7777"`).
- Perf re-check (hot path).

### Non-goals
Full structured-format parsing (JSON/YAML AST walking) — regex-tier only;
multi-line heredoc secrets.

### Approximate ETA
**~1 day.**

## Intake notes
Filed 2026-07-10 from FEAT-459 review secondary finding. Security category.
Depends on FEAT-459 landing (same pattern site, avoid parallel edits).
Unscored; run `/runner:triage`.

## PM triage (2026-07-10)

### Demand assessment
**Who wants this?** Any local daemon operator whose ingested transcripts
contain JSON/PHP-shaped config (agents pasting `.env`-to-JSON, API responses,
config dumps) — a real, security-relevant blast radius for a daemon whose
core trust proposition is "your local memory, not leaked to a third party."
**Evidence, quoted directly:**
`.claude/artifacts/crew/reviews/20260710T082304Z-review-result-feat-459-redaction.md:84-94`
— "Finding 2 (LOW — recommend follow-up, not blocking): quoted/JSON label
forms don't match ... This is a pre-existing gap ... but it's a common
real-world shape for secrets to leak (JSON logs, request/response bodies,
`.env.json`) and worth a follow-up ticket. Not in this FEAT's stated scope,
not blocking." Note the reviewer explicitly rated this **LOW severity**, not
HIGH — tempers urgency relative to a plain reading of the FEAT body.
**Workaround/current mitigation:** partial. Read `src/redact/entropy.ts`
directly: the Shannon-entropy fallback (`MIN_TOKEN_LENGTH = 20`) would catch a
sufficiently long, random JSON-quoted secret VALUE token even without label
matching, since `CONFIG_ASSIGNMENT_RE` (the numeric/boolean guard) requires
the whole token to match `^[A-Za-z][A-Za-z0-9_]*[:=](?:\d+|true|false)$` and a
quoted value token doesn't fit that shape. But per `entropy.ts`'s own
documented design point (lines 10-19), **short** labeled secrets never reach
the 20-char floor and rely entirely on the label-side pattern detector — so
the gap specifically matters for short, labeled secrets in quoted/JSON form,
a narrower but real residual risk than "no protection at all."
**Frequency:** plausible-common per the FEAT's own framing, but not measured;
scored as real but not verified-frequent.

### Scope challenge
**Smallest deliverable:** widen the label-side regex in
`src/redact/detectors.ts` to tolerate a closing quote/apostrophe between
keyword and separator, applied to the `generic_credential` detector only
(same file, same function family as FEAT-459's fix).
**What to cut if halved:** ship JSON double-quote form first (`"KEY": "val"`),
defer PHP `=>` array-arrow form as a fast-follow — both are listed together
but the JSON form is the more common shape per the FEAT's own framing.
**Overlap:** none beyond the direct FEAT-459 lineage — same file, no other
pending/triaged FEAT touches `src/redact/`.
**AC clarity:** scope explicitly mirrors FEAT-459's two-tier precision design
and lists concrete positive/negative fixtures — clear and testable; ACs below
convert it to Given-When-Then form per P1 gating.

### Risk radar
**Technical unknowns:** none new — same file, same detector family as
FEAT-459 (verified: `src/redact/detectors.ts` is the sole `generic_credential`
implementation, confirmed via grep). The "preserve quotes, redact only the
inner value" replacement logic is slightly more delicate than FEAT-459's
lookbehind-only change but stays within the same regex/replace pattern.
**Dependency chain:** `depends_on: [FEAT-459]` — confirmed RESOLVED: git log
shows `8cf7cd3 release: 0.12.1 — stage-0 redaction hardening (FEAT-459) ...`
already shipped. Dependency depth is now zero in practice.
**Blast radius:** 1 file (`src/redact/detectors.ts`) + test files
(`tests/security/redact.test.ts`, `tests/security/redact-perf.test.ts`,
confirmed to exist).
**Failure modes:** logic error (false positive on benign quoted config, the
exact class FEAT-459's own review Finding 1 caught for unquoted compounds);
data/shape corruption if the "preserve quotes" replacement mangles JSON
structure on an edge case (escaped inner quotes, nested structures).
**technical_risk band:** 0.0–0.2 to low 0.3 (known repo pattern — same file,
directly precedented by FEAT-459's own successful fix-and-review cycle; no
schema change; git-revertible) — scored `pm_risk_inverse: 0.75` (≈0.25 direct
risk, slightly above FEAT-459's own implied risk given the added
"preserve-structure" replacement complexity).

**Pre-mortem (mandatory: P1):**
1. *Two weeks later, review/validation failure — most likely cause:* the
   "preserve the quotes, redact inside" replacement subtly breaks JSON
   structural validity on an edge case (e.g. an escaped inner quote `\"`), or
   the widened label regex reintroduces a false positive on benign quoted
   config (`"NODE_ENV": "production"`) — the same class of gap FEAT-459's own
   review caught (Finding 1: keyword-as-middle-token) for a change that
   looked complete against its own stated fixtures.
2. *If this merged and broke the loop — rollback:* revert-only. Same file
   (`src/redact/detectors.ts`) as FEAT-459, no schema/migration, no
   cross-plugin coordination — `git revert` fully restores prior regex
   behavior.
3. *Existing test that would NOT catch a regression:* `tests/security/redact.test.ts`'s
   current fixtures (per the FEAT-459 review itself) cover unquoted
   trailing-keyword compound labels and unlabeled-entropy floors, but — per
   Finding 2 of that same review — nothing today exercises quoted/JSON-shaped
   labels; a regression in the new quoted-form pattern would not be caught
   without this FEAT's new positive/negative JSON/YAML/PHP-array fixtures
   actually landing.

### Grade feedback
Weak dimensions per last 5 grades: `architecture_quality` (0.51),
`observability` (0.654), `production_readiness` (0.504), **`security`
(0.51)**, `product_completeness` (0.504) — all below 0.80. `security` is
directly the domain this FEAT touches — AC-1/AC-2/AC-3 below target it
directly (positive + negative fixtures), and AC-4 targets the weak
`observability` dimension (detector-tagged redaction-log entry) per the
weak-dimension rule for `autonomous_safe: true`.

### Effort calibration
No cost report exists yet for FEAT-459 itself (checked
`.claude/artifacts/crew/cost/` — no `*459*` file), so no direct analog for
this exact detector family. Closest bounded single-project analog remains
FEAT-449 ($72.34/56 min, "medium" shape) as a ceiling; FEAT-463 is narrower in
scope (regex-only extension to one existing file, not a new subsystem) so
expected materially below that ceiling. Scored `pm_effort_inverse: 0.8`
(≈0.2 direct effort), consistent with the FEAT's own ~1-day ETA and its
directly-precedented, single-file shape.

### Decomposition gate
Effort well below the 8-point threshold — no `proposed_slices` needed.

```json
{
  "featureId": "FEAT-463",
  "scores": {
    "customer_impact": 0.5,
    "effort_estimate": 0.2,
    "strategic_alignment": 0.65,
    "technical_risk": 0.25,
    "dependency_depth": 0.05
  },
  "compositePriority": "P1",
  "autonomousSafe": true,
  "demandEvidence": "Quoted directly from the FEAT-459 review artifact (20260710T082304Z): 'Finding 2 (LOW ... recommend follow-up, not blocking): quoted/JSON label forms don't match ... common real-world shape for secrets to leak.' Reviewer rated it LOW severity, not HIGH.",
  "scopeNotes": "Smallest deliverable: widen the label-side regex for the JSON double-quote form first, defer PHP array-arrow form as fast-follow. src/redact/entropy.ts's Shannon-entropy fallback partially mitigates LONG secrets already (MIN_TOKEN_LENGTH=20), but per its own documented design (lines 10-19) short labeled secrets rely entirely on this label pattern, so the residual risk is real but narrower than 'no protection.' Weak grade dimensions security (0.51) and observability (0.654) directly targeted by AC-1/2/3 and AC-4 respectively.",
  "risks": [
    "Pre-mortem 1: quote-preserving replacement could break JSON structural validity on an escaped-quote edge case, or reintroduce a false positive on benign quoted config, mirroring FEAT-459's own review Finding 1.",
    "Pre-mortem 2: rollback is revert-only — same file as FEAT-459, no migration, no cross-plugin coordination.",
    "Pre-mortem 3: tests/security/redact.test.ts today has no quoted/JSON-label fixtures (confirmed by the FEAT-459 review's own Finding 2) — this exact regression class is currently uncovered."
  ],
  "reasoning": "P1: security-domain gap with a direct quote from the FEAT-459 reviewer (rated LOW severity, not blocking, but real), dependency FEAT-459 already shipped (v0.12.1, commit 8cf7cd3), single-file bounded fix directly precedented by FEAT-459's own successful cycle.",
  "acs": [
    "AC-1: Given transcript text containing \"OPENAI_API_KEY\": \"sk-proj-AbCdEf1234567890\", When stage-0 redaction runs the generic_credential detector in src/redact/detectors.ts, Then the value between the quotes is replaced with a [REDACTED:...] placeholder while the surrounding double-quote characters and JSON structure are preserved unchanged.",
    "AC-2: Given transcript text containing 'DB_PASSWORD' => 'hunter2', When the same detector runs, Then hunter2 is redacted and the label 'DB_PASSWORD' and => syntax are left intact.",
    "AC-3: Given benign quoted config lines \"NODE_ENV\": \"production\" and \"PORT\": \"7777\", When the detector runs, Then neither line is redacted, matching the existing numeric/boolean value guard already applied to unquoted forms in detectors.ts.",
    "AC-4: Given a quoted/JSON-label match fires, When the redaction pass completes, Then the match is recorded through the existing src/storage/redaction-log.ts path with a detector-name/pattern-tag distinguishing it from the trailing-unquoted match, so redaction coverage by pattern shape is observable/auditable.",
    "AC-5: Given the widened label regex is exercised against the existing tests/security/redact-perf.test.ts corpus, When the perf test runs, Then redaction throughput stays within the perf test's existing latency budget, confirming no catastrophic-backtracking regex was introduced."
  ]
}
```

## Acceptance criteria

- **AC-1:** Given transcript text containing the JSON double-quoted label/value form `"OPENAI_API_KEY": "sk-proj-AbCdEf1234567890"`, When stage-0 redaction runs the widened `generic_credential` detector in `src/redact/detectors.ts`, Then the captured value group spans only the text between the quotes (`sk-proj-AbCdEf1234567890`), the output replaces it with a `[REDACTED:generic_credential:<hash8>]` placeholder, and the surrounding double-quote characters, the `"OPENAI_API_KEY"` label, and the `: ` separator are left byte-for-byte unchanged — mirroring how the existing `AccountKey=(\S+)` detector already leaves its label untouched (`detectors.ts:52-56`). Also cover, as additional positive fixtures in the same table: the trailing-keyword compound form `"DJANGO_SECRET_KEY": "abcdefgh1234"` (currently unmatched for the same adjacency reason), and a quote sitting directly against the separator with no intervening space, `"SECRET_KEY"=abcdefgh1234` (quoted label, unquoted value) — confirming the widened pattern tolerates a closing quote/apostrophe between keyword and separator independent of whether the value side is itself quoted.
- **AC-2:** Given transcript text containing the PHP array-arrow form `'DB_PASSWORD' => 'hunter2'`, When the detector runs, Then `hunter2` is redacted between its single quotes, and the label `'DB_PASSWORD'` plus the full `=>` arrow are left intact character-for-character. Note for implementation: today's separator match is `\s*[:=]\s*(\S+)`, which for `=>` consumes only the `=` and would wrongly capture `>'hunter2'` as the "value" (extra leading `>`) — the fix must treat `=>` as its own two-character separator alternative, not assume `[:=]` alone covers it.
- **AC-3:** Given the quote-tolerant widening is in place, When the detector runs over each of: benign quoted non-secret config (`"NODE_ENV": "production"`, `"PORT": "7777"`), a quoted numeric/boolean value on an any-segment keyword (`"PASSWORD_MIN_LENGTH": 8`, `"SECRET_SCAN_ENABLED": "true"`), and a quoted mid-word collision (`"authtoken": "abc123456789"`), Then none of these five lines are redacted — the existing numeric/boolean `valueFilter` guard (`detectors.ts:138`) and the `(?<![A-Za-z])` mid-word lookbehind guard both keep applying correctly when the label or value is quoted, not just in the unquoted forms they were originally proven against.
- **AC-4:** Given the full existing `tests/security/redact.test.ts` suite (all `TRUE_POSITIVES` fixtures and all false-positive-guard cases, unmodified), When the suite runs after this change, Then every case still passes with byte-identical redaction behavior on unquoted forms — this FEAT adds new fixtures alongside the existing ones, it does not alter any existing detector behavior for text with no adjacent quote character.
- **AC-5:** Given a quoted/JSON-label match fires (AC-1/AC-2/AC-3), When the redaction pass completes, Then the resulting `RedactionEvent` is recorded through the existing `src/storage/redaction-log.ts` path using a `type` string distinguishable from the plain trailing-unquoted match (e.g. a dedicated detector `type` value such as `generic_credential_quoted`, following the same one-`type`-per-detector-entry convention `PATTERN_DETECTORS` already uses for `azure_key` across its three separate entries in `detectors.ts:52-70`) — this requires no `redaction_log` schema/migration change (confirmed: `migrations/005-security.sql` has only a `type TEXT` column, no pattern-shape sub-field), only an additional detector-table entry with its own `type` value, keeping the change within the single-file (`detectors.ts`) blast radius the PM triage scoped.
- **AC-6:** Given the widened label/value regexes are exercised against the existing `tests/security/redact-perf.test.ts` corpus (the representative auto-capture-shaped payload in `buildRepresentativePayload()`), When the perf smoke test runs, Then p95 latency stays under the test's existing 20ms budget (`redact-perf.test.ts:68`), confirming the added quote-tolerance and `=>`-arrow alternation did not introduce catastrophic backtracking on the hot ingest path.
