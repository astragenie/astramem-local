---
id: FEAT-463
status: pending
priority: null
category: security
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: [FEAT-459]
slices: []
derived_from: .claude/artifacts/crew/reviews/20260710T082304Z-review-result-feat-459-redaction.md
cross_product: [astramem-local]
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
