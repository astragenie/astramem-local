# Engineering OS Constitution

This repository uses the Engineering OS harness for structured software work inside Claude Code.

## Core Rules

1. Keep one owner per task. Shared ownership creates merge conflicts and confused accountability that cost the user time.
2. Keep task scope explicit. Ambiguous scope leads to wasted effort and work that has to be redone.
3. Retrieve bounded repo context before substantial work. Starting without it means paying for rediscovery that was already done.
4. Structured handoffs protect the user from lost context. Without them, the next agent or session starts blind.
5. Treat review as a gate, not a courtesy. Unreviewed code reaching the user's repo is a quality risk they cannot easily undo.
6. Treat validation and deployment evidence as separate gates when behavior or environments are involved. The user needs to know that changed behavior works, not just that code looks correct.
7. Leave durable artifacts and repo memory behind when work would matter later. Skipping them means the next session has no record of what happened or why.

## Team Roles

- lead: planning, delegation, synthesis
- builder: bounded implementation
- reviewer: independent change review
- validator: behavior and scenario verification
- deployer: deployment and environment evidence
- researcher: read-only investigation

## Memory And Artifact Habit

The user depends on artifacts to resume work after compaction, across sessions, or when context is lost.

Substantial work should start from bounded repo memory:

- `CLAUDE.md`
- `.claude/crew/*.md`
- latest relevant wake-up context and artifacts

Substantial work should leave inspectable artifacts under:

- `.claude/artifacts/crew/runs/`
- `.claude/artifacts/crew/handoffs/`
- `.claude/artifacts/crew/reviews/`
- `.claude/artifacts/crew/validations/`
- `.claude/artifacts/crew/deployments/`

For shipping work, keep durable repo deployment guidance in:

- `.claude/crew/deployment.md`

## Scope Discipline

These situations create merge conflicts, wasted effort, or confused ownership that costs the user time. Stop and re-scope if:

- two agents need the same file
- the assignment boundary is unclear
- the work needs a broader refactor than assigned

## Commit Discipline

Baseline: do not create commits unless the user explicitly asks. Unrequested commits in the user's repo are a quality and trust risk they cannot easily undo.

Exception — `dev.stable` opt-in:

- If the current repo's `.claude/crew/deployment.md` contains a `dev.stable: true` setting, the lead and builder MAY create commits without asking on each individual edit, as long as ALL of the following hold:
  - the change came from a `/crew:build` or `/crew:fix` flow that reached the synthesis step
  - the latest review artifact for the run is `PASS` (or `review_skipped` was recorded with an explicit reason)
  - the latest validation artifact for the run is `PASS` (or `validation_skipped` was recorded with an explicit reason)
  - no `help_request` workflow badge is open
  - the work is local commits only — not a release tag, not a force-push, not a production deploy
- If any gate is missing or red, fall back to baseline (ask first).
- The user may override the flag at any time by saying "do not commit" or equivalent during the session. Session-level instruction always beats the repo flag.
- Production promotion, tag pushes, and force-pushes are NEVER unlocked by `dev.stable` — they still require explicit user approval per the deployer rules.

See `agents/deployer.md` → Deployment guidance schema for the field definition.

