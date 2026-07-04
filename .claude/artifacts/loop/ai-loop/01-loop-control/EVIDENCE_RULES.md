# Evidence Rules

A criterion can be marked PASS only with evidence.

## Evidence types

Valid evidence includes:

- file paths changed
- new tests added
- build command executed
- test command executed
- API endpoint implemented
- dashboard page implemented
- migration added
- configuration added
- health check added
- documentation updated

## Invalid evidence

These are not enough:

- “implemented conceptually”
- “should work”
- “designed for”
- “placeholder created”
- “TODO added”
- “not tested but simple”
- “mock exists only”

## PASS

Use PASS only when:

- code exists
- it is wired into the application
- build passes
- tests pass or runtime is externally blocked
- documentation exists when needed

## PARTIAL

Use PARTIAL when:

- some code exists but incomplete
- missing tests
- not wired into app
- missing dashboard
- missing docs
- runtime behavior uncertain

## FAIL

Use FAIL when:

- not implemented
- broken
- skipped
- contradicts requirements

## BLOCKED

Use BLOCKED only when external dependency prevents validation.

BLOCKED requires:

- reason
- missing dependency
- exact command/config needed to unblock
- what was still implemented
