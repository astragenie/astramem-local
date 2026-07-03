# Grades

One markdown file per closed slice capturing scores, lessons learned,
decisions made, and surprises. Lives at `.claude/artifacts/loop/grades/SLICE-NN-grade.md`.

## Lifecycle

1. After slice acceptance criteria PASS:
   `/runner:slice grade --id SLICE-NN`
   Plugin generates a pre-filled template (file only — won't clobber an
   existing grade).
2. Agent edits the grade inline:
   - Sets the seven scores (floats 0.0–1.0).
   - Adds lessons, surprises, followups.
   - Drops one or more `### DEC-TBD: <title>` blocks under `## Decisions`
     for retrospective decisions made during the slice.
   - Fills the narrative sections (What went well / wrong / differently).
3. Persist + extract:
   `/runner:slice grade-write --id SLICE-NN`
   - Validates scores in [0, 1]
   - For each `### DEC-TBD: <title>` block, allocates `DEC-NNN` and writes
     a full ADR-style file under `.claude/artifacts/loop/decisions/`
   - Updates the grade body to replace `DEC-TBD` with the allocated id
   - Appends a `decisions: [DEC-NNN, ...]` array to the grade frontmatter
   - Idempotent on re-run — only extracts blocks still marked `DEC-TBD`.

## Schema

Frontmatter is the structured part. Body is narrative + decisions.

```markdown
---
id: GRADE-SLICE-NN
slice: SLICE-NN
feature: FEAT-NNN
spec: SPEC-NNN | null
phase: <int> | null
target_release: vX.Y.Z | null
graded_at: YYYY-MM-DD
duration_hours: <float> | null
scores:
  architecture_quality: 0.85
  reliability: 0.80
  observability: 0.70
  production_readiness: 0.75
  security: 0.90
  test_confidence: 0.85
  product_completeness: 0.95
decisions: []                # populated by grade-write
---
# SLICE-NN: <title> — Grade

## Scores

- architecture_quality: 0.85
- reliability: 0.80
…

## Lessons

- Free-form bullet — one lesson per line

## Decisions

### DEC-TBD: Server-side pagination for ingestion jobs

**Rationale**: 10k+ jobs per tenant exceeded SignalR payload.

**Consequences**:
- bounded memory footprint
- pagination semantics differ from existing memory-list

## Surprises

- bullet

## Followups

- bullet

## What went well

…

## What went wrong

…

## What I would do differently next time

…
```

## Score guidance

| Dimension | What 1.0 looks like |
|---|---|
| architecture_quality | New code follows established patterns; no anti-pattern violations |
| reliability | All failure modes handled; no new flaky tests |
| observability | Every new code path emits logs/spans/metrics per OTel conventions |
| production_readiness | Healthchecks, config via env vars, no hardcoded secrets, infra-as-code |
| security | Auth + scope + audit-log + secret-store; threat-modeled for the surface |
| test_confidence | Coverage of new logic; integration tests when external deps involved |
| product_completeness | Acceptance criteria all PASS; UX flow polished |

Be honest. A 0.7 with a clear "what needs improving" beats a fake 0.95.
