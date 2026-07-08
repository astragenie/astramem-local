/**
 * Minimal local ambient declaration for `bun:sqlite` — no `bun-types`
 * package is installed in this repo (checked node_modules/@types and
 * node_modules/bun-types: neither present), so this covers just the tiny
 * subset pipeline-direct.ts actually calls rather than adding a new
 * devDependency for one throwaway in-memory table. Real behavior comes
 * from Bun's runtime at execution time; this file only satisfies `tsc`.
 */
declare module 'bun:sqlite' {
  export class Database {
    constructor(path: string);
    exec(sql: string): void;
  }
}
