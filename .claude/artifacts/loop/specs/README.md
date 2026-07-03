# Specs

Strategic / product-level inputs that decompose into features. Higher-tier
than the backlog — fewer files, longer-lived, narrative-heavy.

## Types

| Type | What |
|---|---|
| `prd` | Product Requirements Document. Goals, non-goals, user stories, success metrics. |
| `user-journey` | End-to-end user flow with acceptance per step. |
| `sre` | Reliability target / constraint (SLOs, error budgets, alert posture). |
| `research` | Time-boxed investigation. Questions, findings, recommendation. |
| `adr` | Architecture Decision Record. Context, decision, consequences. |
| `other` | Anything that doesn't fit the above. |

## File naming

`SPEC-NNN.md` (zero-padded, monotonically increasing across all types).
The `type` field in frontmatter disambiguates content shape; the filename
stays uniform so plugin tooling can list / link without knowing the type.

## Status lifecycle

- `draft` — being authored
- `approved` — reviewed, ready to decompose
- `decomposed` — features (`FEAT-NNN`) have been derived; listed in `derived_features`
- `satisfied` — every derived feature has reached `done`
- `archived` — deprecated / no longer in scope

Plugin auto-rolls `decomposed` → `satisfied` once all derived features are
done (see `/runner:spec status`).

## Authoring

Three ways:

1. `/runner:spec add --type prd "title"` — plugin creates a well-formed
   draft file with frontmatter.
2. Manually copy a `<type>-template.md` and fill in.
3. From an external producer (same as backlog — any writer that drops a
   valid markdown file works).

## Decomposing

After a spec is `approved`:

```
/runner:spec decompose --id SPEC-NNN --features "feature 1; feature 2; feature 3"
```

Plugin creates `FEAT-NNN.md` files in `.claude/artifacts/loop/backlog/pending/` with
`derived_from: SPEC-NNN` and updates the spec's `derived_features` list.

Triage + slice derivation happen downstream via the normal backlog flow.
