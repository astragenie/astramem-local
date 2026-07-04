---
id: SLICE-NN
status: pending
feature: FEAT-NNN          # parent feature id; null for spec-derived slices
phase: null
priority: null              # P0|P1|P2|P3
target_release: null
requires_validation: false
created: YYYY-MM-DD
updated: YYYY-MM-DD
# GitHub linkage (populated by /runner:publish; leave null until publish runs)
github_issue: null          # sub-issue number attached to the parent FEAT issue
github_url: null            # full URL, e.g. https://github.com/owner/repo/issues/43
github_pr: null             # PR number once the slice lands a code change
---
# SLICE-{{NN}}: {{title}}

- **Priority**: {{P0|P1|P2}}
- **Status**: Pending
- **Author**: {{author}}
- **Created**: {{ISO-date}}

## Objective

One sentence describing the user-visible outcome of this slice.

## Why now

What unblocks this slice. What this slice unblocks for future slices.

## In scope

- bullet list of what the slice will produce
- be specific about files, services, modules, endpoints

## Out of scope

- bullet list of things explicitly NOT in this slice
- punt these to a future slice referenced by name

## Acceptance criteria

List each criterion the slice must meet. Each must be testable with evidence
per `01-loop-control/EVIDENCE_RULES.md`.

- [ ] AC-1: ...
- [ ] AC-2: ...
- [ ] AC-3: ...

## Done When

The slice is complete only when:

- all acceptance criteria above are PASS with evidence
- build passes per `.claude/loop.json` `stack.build`
- tests pass per `.claude/loop.json` `stack.test`
- Crew `review-result` artifact written
- Crew `final-synthesis` artifact written
- entry appended to `../backlog/completed-slices.md`
- this slice file moved from `slices/pending/` to `slices/active/` then to
  `slices/completed/` as it progresses

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...

## Risks

- ...

## Open questions

- ...
