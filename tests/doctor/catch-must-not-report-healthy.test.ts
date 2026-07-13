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
 * If this test fails: you wrote a catch block that reports healthy. Return
 * `{ ok: true, inconclusive: true, message: '...: CHECK FAILED TO RUN (not a
 * clean bill of health): ...' }` — or `{ ok: false }` if a throw genuinely
 * means broken.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CHECKS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../src/doctor/checks.ts');

/** Extract the body of every `catch (...) { ... }` block, brace-matched. */
function catchBlocks(src: string): Array<{ line: number; body: string }> {
  const blocks: Array<{ line: number; body: string }> = [];
  const re = /\bcatch\s*(?:\([^)]*\)\s*)?\{/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1; // index of the `{`
    let depth = 0;
    let end = -1;

    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;

    blocks.push({
      line: src.slice(0, m.index).split('\n').length,
      body: src.slice(open + 1, end),
    });
  }
  return blocks;
}

describe('doctor checks: a catch block must never report a clean bill of health (ADR-015)', () => {
  const src = readFileSync(CHECKS_PATH, 'utf8');

  it('finds catch blocks to inspect (guards against the scanner silently matching nothing)', () => {
    // A scanner that matches zero blocks would vacuously "pass" forever — the
    // very failure mode this file is about. Assert it actually has teeth.
    expect(catchBlocks(src).length).toBeGreaterThan(20);
  });

  it('no catch block returns ok: true without marking the result inconclusive', () => {
    const offenders = catchBlocks(src)
      .filter(b => /\bok\s*:\s*true\b/.test(b.body) && !/\binconclusive\s*:\s*true\b/.test(b.body))
      .map(b => `  src/doctor/checks.ts:${b.line}`);

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `\n\nA doctor check reports HEALTHY from inside a catch block:\n\n${offenders.join('\n')}\n\n` +
          `A check that could not RUN is not a check that PASSED. Reporting ok:true here means a\n` +
          `broken probe is indistinguishable from a healthy system — doctor prints green while the\n` +
          `thing it is supposed to be watching is on fire. This bug has been introduced FOUR times\n` +
          `in this file (see this test's header), every time by someone who knew the rule.\n\n` +
          `Use the inconclusive tier instead:\n\n` +
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
