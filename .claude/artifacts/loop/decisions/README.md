# Decisions

Retrospective architecture decisions captured during slice work. ADR-style
files at `.claude/artifacts/loop/decisions/DEC-NNN.md`. Distinct from `.claude/artifacts/loop/specs/` (type=adr)
which are forward-looking design decisions made BEFORE work begins; these
are decisions that emerged DURING implementation.

## How they're created

Decisions originate in grade files (`.claude/artifacts/loop/grades/SLICE-NN-grade.md`) under
the `## Decisions` section as `### DEC-TBD: <title>` blocks. When the agent
runs `/runner:slice grade-write`, the plugin:

1. Allocates the next `DEC-NNN` id
2. Writes a full ADR file at `.claude/artifacts/loop/decisions/DEC-NNN.md` from `decision-template.md`
3. Updates the grade body to replace `DEC-TBD` with `DEC-NNN`
4. Appends the id to the grade frontmatter `decisions: [...]`

Idempotent — only blocks still marked `DEC-TBD` are extracted on re-run.

## Lifecycle

- `status: accepted` — current valid decision
- `status: superseded` — newer decision replaces this; `superseded_by: DEC-NNN`
- `status: reverted` — decision rolled back; usually paired with a `surprises`
  entry in the next grade file explaining what went wrong

## Inspecting

- `/runner:decisions list [--status accepted|superseded|reverted]`
- `/runner:decisions show --id DEC-NNN`
