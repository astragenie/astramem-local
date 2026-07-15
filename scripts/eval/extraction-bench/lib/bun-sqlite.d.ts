/**
 * Minimal local ambient declaration for `bun:sqlite` — no `bun-types`
 * package is installed in this repo (checked node_modules/@types and
 * node_modules/bun-types: neither present), so this covers just the subset
 * of the API actually called across scripts/eval/**, rather than adding a
 * new devDependency for a handful of call sites. Real behavior comes from
 * Bun's runtime at execution time; this file only satisfies `tsc`.
 *
 * Extended by scripts/eval/onnx-embedder-benchmark.mts (ADR-018 benchmark)
 * to add `prepare()`/`Statement.all()`/`close()` + the readonly-mode
 * constructor overload, mirroring scripts/eval/onnx-parity.mts's own usage
 * on the feat/onnx-embed-provider-s3-parity branch — same tiny surface,
 * kept in this single ambient file rather than a second duplicate
 * declaration (TS does not allow two `declare module 'bun:sqlite'` class
 * bodies to coexist under the same tsconfig.eval.json include glob).
 */
declare module 'bun:sqlite' {
  export class Statement {
    all(...params: unknown[]): unknown[];
  }
  export class Database {
    constructor(path: string, opts?: { readonly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }
}
