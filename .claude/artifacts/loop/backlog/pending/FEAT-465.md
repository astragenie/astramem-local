---
id: FEAT-465
status: pending
priority: null
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: .claude/artifacts/crew/reviews/20260710T121205Z-review-result-slice-420-feat-461-config-yaml.md (Finding 2, MEDIUM)
cross_product: [astramem-local]
autonomous_safe: null
tags: ["concern:config", "stack:typescript", "surface:daemon"]
---
## Description

**config.yaml loader comment-stripping corrupts string values containing ` #`** —
`src/config/loader.ts` strips comments with a quote-unaware regex
(`/(^|\s)#.*$/`), so any scalar whose value contains a `#` preceded by
whitespace is silently truncated at load time. Pre-existing (affects e.g. a
quoted `ollama.baseUrl` containing ` #`), but newly exercised by
`security.redaction.customPatterns` (FEAT-461) — the first field intended to
hold arbitrary user regex source, where `#` is common.

Reproduced in the SLICE-420 review: pattern `'hash #tag no leading space'`
round-trips as the corrupted string `["hash`.

### Scope

- Make comment-stripping quote-aware in the hand-rolled loader: a `#` inside
  single/double quotes (and inside a `[...]` flow sequence) is content, not a
  comment delimiter.
- Round-trip tests: `#`-bearing quoted scalars, `#`-bearing entries inside
  flow-sequence arrays, actual trailing comments still stripped, inline
  comment after quoted value still stripped.
- Remove/adjust the FEAT-461 CHANGELOG caveat ("`#` in customPatterns
  unsupported") once fixed.

### Non-goals

- Not a YAML-library migration — keep the minimal hand-rolled loader; that
  larger decision belongs to a separate FEAT if ever needed.
