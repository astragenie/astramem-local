/**
 * The broken shape is the DEFAULT shape. This test exists because guidance failed.
 *
 * On 2026-07-13, #208 fixed nine doctor checks that did this:
 *
 *     } catch {
 *       return { ok: true, message: 'thing: OK (non-fatal)' };
 *     }
 *
 * A check that CANNOT RUN reports a clean bill of health. The daemon could be
 * on fire and doctor prints green. This is the exact inversion ADR-015 (the
 * loud-failure invariant) exists to forbid: "a path MUST be able to distinguish
 * a REAL zero from a BROKEN zero."
 *
 * Within HOURS of #208 merging, THREE new canaries (fix-200, fix-205, fix-207)
 * independently reintroduced the identical bug — written by agents who had read
 * ADR-015 and cited it by name in their own code comments. A fourth
 * (checkEntityNameQuality, #218) shipped with it too.
 *
 * That is not four careless authors. That is a defect in the default: when you
 * are writing a health check and reach the catch block, `ok: true` is the shape
 * your fingers type, because "don't fail the whole doctor run over one probe"
 * is a reasonable instinct. The instinct is right; the encoding is wrong. The
 * correct encoding is the `inconclusive` tier — "I could not measure this,"
 * which is neither pass nor fail.
 *
 * Documentation cannot fix a bad default. A test can.
 *
 * If this test fails: you wrote a code path that reports healthy on an error
 * path. Return `{ ok: true, inconclusive: true, message: '...: CHECK FAILED
 * TO RUN (not a clean bill of health): ...' }` — or `{ ok: false }` if a throw
 * genuinely means broken.
 *
 * ── #220 (2026-07-13): syntax scope, widened past checks/ ──────────────────
 * 2026-07-13 split: `src/doctor/checks.ts` (2,167 lines, every core check in
 * one file) became a thin re-export shim over `src/doctor/checks/*.ts` (one
 * file per check) — see that directory's `index.ts` doc comment for why. The
 * catch blocks this scanner exists to police moved with the checks; scanning
 * only the shim would silently stop finding any of them (exactly the
 * "scanner silently matching nothing" failure the first test below guards
 * against), so this scans every source file in the split directory instead.
 * PR #231's own split commit updated this in the same commit that cut the
 * shim over — verified this had NOT gone silently blind (issue #220's other
 * half). `checks/` is also not the only place `Check` literals get built:
 * gpu-checks.ts, hardening-checks.ts, and cli/providers.ts are the complete
 * remainder (#232's tier audit). Widening to include them caught 3 live
 * violations sitting unscanned in hardening-checks.ts.
 *
 * ── #256 (2026-07-13): semantic scope, widened past "inside a catch" ───────
 * The brace-matching-on-`catch{...}` scanner above is blind to the shape
 * `checkSilentCpuOffload` shipped with:
 *
 *     let models: X | null;
 *     try { models = await fetch(); } catch { models = null; }
 *     if (models === null) return { ok: true, message: '...skipped...' };
 *
 * The `ok: true` is not lexically inside the catch block — it is in a
 * downstream `if` guarded by a variable the catch assigned. Regex brace-
 * matching cannot see this; it required an AST. `scanFile` below parses each
 * file with the TypeScript compiler (already a project devDependency, no new
 * package) and flags an `ok: true` (no `inconclusive`) `return` whose nearest
 * enclosing `if` condition (walking up to the function boundary) references
 * a variable that some `catch` clause in the SAME function assigned. This
 * subsumes the original in-catch-body rule (a return whose ANCESTOR is
 * itself a CatchClause is the degenerate case: zero `if` hops needed) and
 * catches the branch-guarded shape #256 found live.
 *
 * Known residual (documented, not silently missing): a below-floor /
 * insufficient-data branch (`if (total < MEANINGFUL_USAGE_THRESHOLD) return
 * { ok: true }`) is the SAME "not actually verified" bug in spirit — #255's
 * review found it independently in auto-capture.ts, and the identical shape
 * exists in entity-link-rate.ts and usefulness-feedback-loop.ts. This scanner
 * deliberately does NOT flag it: there is no syntactic marker distinguishing
 * a floor/threshold guard from any other legitimate early-return (`redaction.
 * ts`'s "0 secrets redacted" and `budget.ts`'s "no DB yet" are both genuine,
 * verified `ok: true` and would collide with any regex/AST rule keyed on
 * "comparison against a THRESHOLD-ish constant"). Enforcing this here would
 * also immediately turn entity-link-rate.ts / usefulness-feedback-loop.ts red
 * with no in-scope way to fix them in this PR. Proposed home instead: a
 * shared `insufficientData(message)` helper in checks/shared.ts that every
 * below-floor branch calls — gives future mechanical enforcement a real
 * syntactic hook. Tracked for follow-up, not fixed here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CHECKS_DIR = join(REPO_ROOT, 'src/doctor/checks');

// checks/ is not the only place `Check` literals get constructed. #232's
// tier audit confirmed these three files are the complete remainder:
// gpu-checks.ts and hardening-checks.ts are sibling registries to checks/
// (their own `Check[]` factories, just not folded into coreChecks() yet),
// and cli/providers.ts builds ad-hoc Check literals inline for the
// `providers` CLI command's live probes.
const EXTRA_FILES = [
  join(REPO_ROOT, 'src/doctor/gpu-checks.ts'),
  join(REPO_ROOT, 'src/doctor/hardening-checks.ts'),
  join(REPO_ROOT, 'src/cli/providers.ts'),
];

function checkFiles(): string[] {
  const splitDir = readdirSync(CHECKS_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => join(CHECKS_DIR, f));
  return [...splitDir, ...EXTRA_FILES];
}

interface Offender {
  file: string;
  line: number;
  /** 'direct' = return lexically inside a catch block (the original rule).
   *  'branch' = return guarded by an if() referencing a catch-assigned var
   *  (the #256 shape: catch sets a flag, a later branch reports healthy). */
  shape: 'direct' | 'branch';
}

/** Walk up from `node` to (but not including) `scope`, returning the
 *  condition of every enclosing IfStatement whose then/else arm directly
 *  contains the walk (handles both `if (x) return ...;` and
 *  `if (x) { return ...; }`, and nested ifs). */
function enclosingIfConditions(node: ts.Node, scope: ts.Node): ts.Expression[] {
  const conds: ts.Expression[] = [];
  let cur: ts.Node = node;
  while (cur && cur !== scope) {
    const parent: ts.Node | undefined = cur.parent;
    if (parent && ts.isIfStatement(parent) && (parent.thenStatement === cur || parent.elseStatement === cur)) {
      conds.push(parent.expression);
    }
    if (!parent) break;
    cur = parent;
  }
  return conds;
}

/** True if `node`'s nearest enclosing CatchClause (if any) is within `scope`
 *  — i.e. the return is lexically inside a catch block, the original rule's
 *  shape. */
function isInsideCatchClause(node: ts.Node, scope: ts.Node): boolean {
  let cur: ts.Node | undefined = node;
  while (cur && cur !== scope) {
    if (ts.isCatchClause(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Is `cond` a DIRECT nullish/falsy check on a catch-assigned variable —
 * `x`, `!x`, `x === null`, `x == null`, `null === x`, `x === undefined` (or
 * a `&&`/`||` composition of these)? Deliberately narrow, not "does this
 * condition merely MENTION the variable anywhere" — the first version of
 * this scanner used a mention-anywhere walk and false-positived on
 * `if (models.length === 0)`, a condition on a PROPERTY of `models` reached
 * only on the confirmed-non-null path (guarded by an earlier `if (models
 * === null) return inconclusive` above it — TypeScript's own narrowing
 * proves that branch already excludes the catch's error path). A condition
 * that only touches the variable through a property/method access is
 * downstream of a successful read, not evidence of an unverified one.
 */
function isDirectCatchVarGuard(cond: ts.Expression, names: Set<string>): boolean {
  const e = ts.isParenthesizedExpression(cond) ? cond.expression : cond;
  if (ts.isIdentifier(e)) return names.has(e.text);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    return isDirectCatchVarGuard(e.operand, names);
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      return isDirectCatchVarGuard(e.left, names) || isDirectCatchVarGuard(e.right, names);
    }
    const isEqualityOp = [
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ].includes(op);
    if (isEqualityOp) {
      const isNullishLiteral = (n: ts.Expression): boolean =>
        n.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(n) && n.text === 'undefined');
      const leftIsVar = ts.isIdentifier(e.left) && names.has(e.left.text);
      const rightIsVar = ts.isIdentifier(e.right) && names.has(e.right.text);
      if (leftIsVar && isNullishLiteral(e.right)) return true;
      if (rightIsVar && isNullishLiteral(e.left)) return true;
    }
  }
  return false;
}

/** `{ ok: true, ... }` present, `inconclusive: true` absent — the shape
 *  ADR-015 forbids on any code path that did not actually verify health. */
function isOkTrueWithoutInconclusive(expr: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(expr)) return false;
  let ok = false;
  let inconclusive = false;
  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    if (prop.name.text === 'ok' && prop.initializer.kind === ts.SyntaxKind.TrueKeyword) ok = true;
    if (prop.name.text === 'inconclusive' && prop.initializer.kind === ts.SyntaxKind.TrueKeyword) inconclusive = true;
  }
  return ok && !inconclusive;
}

function nearestFunctionScope(node: ts.Node): ts.Node {
  let cur: ts.Node | undefined = node;
  while (cur && !ts.isFunctionLike(cur)) cur = cur.parent;
  return cur ?? node;
}

function scanFile(path: string, src: string): Offender[] {
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenders: Offender[] = [];

  // Pass 1: for every function-like scope, collect the set of plain
  // identifiers assigned by ANY of its catch clauses (`ident = expr;` —
  // not a fresh `let`/`const`, which would be catch-block-scoped and
  // invisible to code after the catch anyway; every real instance of this
  // bug pre-declares the variable above the try and assigns it in catch).
  const catchVarsByScope = new Map<ts.Node, Set<string>>();

  function collectCatchVars(node: ts.Node): void {
    if (ts.isCatchClause(node)) {
      const scope = nearestFunctionScope(node);
      const names = catchVarsByScope.get(scope) ?? new Set<string>();
      const walkAssignments = (n: ts.Node): void => {
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left)
        ) {
          names.add(n.left.text);
        }
        ts.forEachChild(n, walkAssignments);
      };
      walkAssignments(node.block);
      catchVarsByScope.set(scope, names);
    }
    ts.forEachChild(node, collectCatchVars);
  }
  collectCatchVars(sf);

  // Pass 2: every return statement anywhere in a scope that has at least
  // one catch clause is a candidate — check both the "direct" (inside the
  // catch) and "branch" (guarded by a catch-assigned variable) shapes.
  function visitReturns(node: ts.Node): void {
    if (ts.isReturnStatement(node) && node.expression) {
      const scope = nearestFunctionScope(node);
      const catchVars = catchVarsByScope.get(scope);
      if (catchVars && isOkTrueWithoutInconclusive(node.expression)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        if (isInsideCatchClause(node, scope)) {
          offenders.push({ file: path, line, shape: 'direct' });
        } else {
          const conds = enclosingIfConditions(node, scope);
          if (conds.some(c => isDirectCatchVarGuard(c, catchVars))) {
            offenders.push({ file: path, line, shape: 'branch' });
          }
        }
      }
    }
    ts.forEachChild(node, visitReturns);
  }
  visitReturns(sf);

  return offenders;
}

describe('doctor checks: no code path reachable from a catch reports a clean bill of health (ADR-015)', () => {
  const files = checkFiles();
  const perFile = files.map(path => ({ path, src: readFileSync(path, 'utf8') }));

  it('finds catch blocks to inspect (guards against the scanner silently matching nothing)', () => {
    // A scanner that matches zero catch clauses would vacuously "pass"
    // forever — the very failure mode this file is about. Assert it
    // actually has teeth by re-parsing and counting CatchClause nodes.
    let total = 0;
    for (const f of perFile) {
      const sf = ts.createSourceFile(f.path, f.src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const count = (n: ts.Node): void => {
        if (ts.isCatchClause(n)) total++;
        ts.forEachChild(n, count);
      };
      count(sf);
    }
    expect(total).toBeGreaterThan(20);
  });

  it('no return reachable from a catch (directly, or via a branch guarded by a catch-assigned variable) reports ok:true without inconclusive', () => {
    const offenders = perFile.flatMap(f =>
      scanFile(f.path, f.src).map(
        o => `  ${o.file.split(/[\\/]/).slice(-3).join('/')}:${o.line} (${o.shape})`,
      ),
    );

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `\n\nA doctor check reports HEALTHY on a code path reached from a catch block:\n\n${offenders.join('\n')}\n\n` +
          `'direct' = the return is lexically inside the catch. 'branch' = the return is in an if() guarded by\n` +
          `a variable a catch assigned (e.g. \`catch { x = null; } ... if (x === null) return { ok: true };\`) —\n` +
          `just as broken: the check never verified anything, and the ok:true renders identically to one that did.\n\n` +
          `A check that could not RUN is not a check that PASSED. Use the inconclusive tier instead:\n\n` +
          `    } catch (err) {\n` +
          `      return {\n` +
          `        ok: true,\n` +
          `        inconclusive: true,\n` +
          `        message: \`<name>: CHECK FAILED TO RUN (not a clean bill of health): \${err}\`,\n` +
          `      };\n` +
          `    }\n\n` +
          `...or return ok:false if a throw genuinely means the subject is broken.\n`,
    ).toEqual([]);
  });
});
