## What

<!-- One-paragraph summary of the change. -->

## Why

<!-- Context, issue link, or spec reference. -->

## Test plan

- [ ] `npm run build` passes (tsc clean)
- [ ] `npm test` green locally
- [ ] CI matrix green (all 3 OS × 2 Node cells)
- [ ] `src/contracts/` unchanged OR reviewer sign-off obtained (frozen interface)
- [ ] New migrations append-only (no ALTER TABLE, no DROP)

## Notes for reviewer

<!-- Anything that needs explicit attention: native module changes, new env vars, sqlite-vec Windows quirks. -->
