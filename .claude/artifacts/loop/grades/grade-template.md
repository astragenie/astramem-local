---
id: GRADE-SLICE-NN
slice: SLICE-NN
feature: FEAT-NNN
spec: null
phase: null
target_release: null
graded_at: YYYY-MM-DD
duration_hours: null
scores:
  architecture_quality: 0
  reliability: 0
  observability: 0
  production_readiness: 0
  security: 0
  test_confidence: 0
  product_completeness: 0
timing:
  wall_clock_seconds: null
  phase_gate_parallel: null
  post_builder_fanout: null
  reviewer_span_ms: null
  serial_reviewer_warning: false
shape:
  classified: null
  inline_path_used: false
decisions: []
---
# SLICE-NN: <title> — Grade

## Scores

- architecture_quality: 0.00
- reliability: 0.00
- observability: 0.00
- production_readiness: 0.00
- security: 0.00
- test_confidence: 0.00
- product_completeness: 0.00

(Update both the frontmatter `scores:` map and this list. The frontmatter
is what plugin commands read; the list is for human review.)

## Lessons

- bullet 1
- bullet 2

## Decisions

### DEC-TBD: Short decision title

**Rationale**: Why this decision was made.

**Consequences**:
- positive bullet
- negative bullet

(Drop one `### DEC-TBD:` block per decision. Plugin assigns real DEC-NNN
ids on `/runner:slice grade-write`.)

## Surprises

- bullet

## Followups

- bullet

## What went well

(narrative)

## What went wrong

(narrative)

## What I would do differently next time

(narrative)

## References

- slice file: `<slicesRoot>/.../<SLICE_NN>.md`
- feature file: `.claude/artifacts/loop/backlog/done/FEAT-NNN.md`
- review artifact: `.claude/artifacts/crew/reviews/<...>.md`
- validation artifact: `.claude/artifacts/crew/validations/<...>.md`
