/**
 * Doctor check registry — thin re-export shim.
 *
 * The registry (register()/getChecks()), every core check, and the
 * DoctorCheckOpts/openProductionDbReadonly shared surface now live under
 * `src/doctor/checks/` (one file per check, aggregated by `checks/index.ts`)
 * — see that file's doc comment for the full split rationale. This file
 * exists only so every pre-existing import of `../doctor/checks.js` (the CLI
 * commands, `doctor/schedule.ts`, every `tests/doctor/*-check.test.ts` file)
 * keeps working unchanged.
 *
 * Registry API:
 *   register(check: Check): void
 *   getChecks(): Check[]
 *
 * Example (a track adding its own check):
 *   import { register } from '../doctor/checks.js';
 *   register({ name: 'No stuck jobs', run: async () => { ... } });
 */
export * from './checks/index.js';
