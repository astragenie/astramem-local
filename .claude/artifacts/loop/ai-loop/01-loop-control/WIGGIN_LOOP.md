# Wiggin Loop — Autonomous Implementation Loop

The wiggin loop is a strict iterative engineering loop.

Its goal is to prevent the agent from stopping after a shallow implementation.

## Loop

Each iteration must follow this sequence:

```text
DISCOVER
→ PLAN
→ IMPLEMENT
→ BUILD
→ TEST
→ REVIEW
→ SCORE
→ FIX
→ REPEAT
```

## Step 1 — Discover

Inspect the current repository before coding.

Required discovery:

- solution files
- backend projects
- frontend/dashboard projects
- test projects
- database/migration strategy
- configuration strategy
- existing service registrations
- existing storage model
- existing search/RAG implementation
- existing dashboard routing/pages
- existing docs
- existing CI/CD scripts if present

## Step 2 — Plan

Produce a short implementation plan for the current slice.

The plan must include:

- objective
- files likely to change
- risks
- validation commands
- acceptance criteria impacted

## Step 3 — Implement

Implement the smallest valuable vertical slice.

Rules:

- no big-bang rewrite
- no deleting working features
- no fake completed stubs
- no hardcoded secrets
- no hardcoded tenant/project IDs
- no architecture bypasses

## Step 4 — Build

Run the relevant build command.

Typical commands:

```bash
dotnet build
dotnet test
npm run build
pnpm build
yarn build
```

Use the repo’s actual commands if different.

## Step 5 — Test

Run existing tests and add new tests for new behavior.

Do not skip tests unless impossible. If impossible, document why.

## Step 6 — Review

Use the review rubrics under `.claude/artifacts/loop/ai-loop/05-review-rubrics/`.

Review:

- architecture
- security
- observability
- tenant isolation
- dashboard UX
- production readiness
- test coverage

## Step 7 — Score

Score the current implementation:

```text
architecture quality: 0.0-1.0
reliability: 0.0-1.0
observability: 0.0-1.0
production readiness: 0.0-1.0
dashboard usability: 0.0-1.0
test confidence: 0.0-1.0
product completeness: 0.0-1.0
```

## Step 8 — Fix

Fix all criteria that are FAIL or PARTIAL when possible.

## Step 9 — Repeat

Repeat until stop conditions are satisfied.
