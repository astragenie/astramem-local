/**
 * Shared CLI argv-parsing helpers (docs/specs/20260723-codebase-refactor-plan.md).
 *
 * `parseArg` was copy-pasted verbatim into ~18 `src/cli/*.ts` command
 * modules and `hasFlag` into 3 more — pure `string[]` functions with zero
 * variance across every copy. One shared implementation here; every command
 * module imports instead of redeclaring.
 */

/** Returns the value immediately following `flag` in `args`, or `undefined` if `flag` is absent. */
export function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Returns whether `flag` appears anywhere in `args`. */
export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}
