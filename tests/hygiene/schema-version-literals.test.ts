/**
 * ADR-016 rule 1, generalized past the migrations-only case
 * (docs/adr/ADR-016-junction-invariant.md §6 "Enforcement"):
 *
 *   "tests/hygiene/ already has no-hardcoded-embed-dim.test.ts as the
 *   pattern to follow -- a no-hardcoded-schema-version.test.ts sibling
 *   that greps for the same shape does not exist yet and should be added."
 *
 * Before src/storage/schema-version.ts existed, SCHEMA_VERSION was a
 * hardcoded integer literal in NINE places (see that file's own header
 * comment) -- plus a TENTH, found later, hiding inside a toThrow() regex
 * string in tests/storage/migrate.test.ts, invisible to a naive
 * toBe(N)/toHaveLength(N) grep because it lived inside a string-matched
 * error message rather than a numeric assertion. PRs #229/#233 fixed all
 * ten. Nothing currently stops an eleventh from being reintroduced -- this
 * is that guard.
 *
 * Design note (read before "simplifying" this file):
 *
 * A blanket "does this file contain the digit sequence for today's
 * SCHEMA_VERSION" scan drowns in false positives the moment you run it
 * against this repo's actual tests/storage/migrate.test.ts -- which
 * legitimately contains lines like:
 *
 *   db.prepare("... WHERE version = 40").run();
 *
 * That "40" is NOT a hardcoded SCHEMA_VERSION -- it addresses migration
 * file 040's own row by its permanent, immutable number (which never
 * drifts: migration 040 is always migration 040, no matter how many later
 * migrations land). It only numerically COINCIDES with today's derived
 * SCHEMA_VERSION because 040 currently happens to be the newest migration.
 * The two concepts are different in kind ("the Nth migration's own id" vs
 * "the current max across all migrations") and a scanner that can't tell
 * them apart is worse than no scanner: it fires on correct code and trains
 * people to ignore it.
 *
 * So this file uses three narrow, independently-justified signatures
 * instead of one blanket regex -- each one derived from where the real
 * nine-plus-one hardcoded literals actually lived, not from a guess:
 *
 *   1. `SCHEMA_VERSION = <today's value>` / `SCHEMA_VERSION: <today's value>`
 *      -- a re-declaration of the constant itself, anywhere outside its one
 *      legitimate home (src/storage/schema-version.ts's own derivation).
 *      This is the wire-meta.ts shape the original bug had.
 *   2. `.toBe(<today's value>)` / `.toHaveLength(<today's value>)` on a line
 *      whose nearby context (same line or the 3 lines above it) mentions
 *      SCHEMA_VERSION / schema_version / schemaVersion / migration -- this
 *      is the eight-test-file shape the original bug had. Requiring BOTH
 *      the exact forbidden number AND a schema/migration-flavored neighbor
 *      is what keeps this from firing on every unrelated toBe(40) sitting
 *      somewhere else in a large suite.
 *   3. A schema/migration-flavored string or regex passed to `toThrow(...)`
 *      that embeds today's value as a bare number instead of interpolating
 *      the constant -- this is the tenth literal's shape exactly
 *      (tests/storage/migrate.test.ts's `/... DB says 39/` regex, since
 *      fixed to interpolate `${SCHEMA_VERSION}`). Scoping this to toThrow()
 *      specifically -- rather than "any string that mentions schema and a
 *      number" -- is what excludes the legitimate raw-SQL WHERE-clause
 *      literals above: none of them sit inside a toThrow() assertion.
 *
 * The forbidden value itself is derived, not typed in by hand -- the same
 * deriveSchemaVersion() this file is protecting, imported directly, so this
 * test's own "what number is bad" answer can never itself go stale.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { deriveSchemaVersion, MIGRATIONS_DIR } from '../../src/storage/schema-version.js';

const ROOT = join(__dirname, '..', '..');

// The only two files a hardcoded-looking match here is not a violation:
// schema-version.ts is the one legitimate place the derivation itself
// lives (Math.max over parsed migration filenames -- no literal target
// value), and this file documents the forbidden shapes in prose, which
// necessarily mentions "SCHEMA_VERSION" and "migration" throughout.
const EXEMPT_FILES = new Set([
  join('src', 'storage', 'schema-version.ts'),
  join('tests', 'hygiene', 'schema-version-literals.test.ts'),
]);

const SCAN_DIRS = ['src', 'tests'];
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.claude']);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      out.push(...listTsFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

// Derived, not typed in by hand -- see file header.
const FORBIDDEN = deriveSchemaVersion(MIGRATIONS_DIR);

const SCHEMA_KEYWORD_RE = /SCHEMA_VERSION|schema[-_]?version|migration/i;

interface Offense {
  file: string;
  line: number;
  snippet: string;
  reason: string;
}

function numberBoundaryRe(n: number): RegExp {
  return new RegExp(`(?<!\\d)${n}(?!\\d)`);
}

function scanFile(absPath: string): Offense[] {
  const rel = relative(ROOT, absPath);
  if (EXEMPT_FILES.has(rel)) return [];

  const text = readFileSync(absPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const offenses: Offense[] = [];
  const numRe = numberBoundaryRe(FORBIDDEN);

  // Signature 1: SCHEMA_VERSION re-declared as today's literal value,
  // either `= <n>` (const/var/let, with or without a `: number` type
  // annotation) or `: <n>` (object-literal property, e.g. a mock factory).
  const declEqRe = /\bSCHEMA_VERSION\b\s*(?::\s*number\s*)?=\s*(\d+)\b/;
  const declColonRe = /\bSCHEMA_VERSION\s*:\s*(\d+)\s*[,}]/;

  // Signature 2: toBe(<n>) / toHaveLength(<n>) -- schema/migration context
  // required nearby (checked separately, see below).
  const toBeRe = /\.(?:toBe|toHaveLength)\(\s*(\d+)\s*\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const declMatch = declEqRe.exec(line) ?? declColonRe.exec(line);
    if (declMatch && Number(declMatch[1]) === FORBIDDEN) {
      offenses.push({
        file: rel,
        line: i + 1,
        snippet: line.trim(),
        reason:
          `SCHEMA_VERSION re-declared as the literal ${FORBIDDEN} instead of imported from ` +
          `src/storage/schema-version.ts (or its wire-meta.ts re-export)`,
      });
      continue;
    }

    const toBeMatch = toBeRe.exec(line);
    if (toBeMatch && Number(toBeMatch[1]) === FORBIDDEN) {
      const windowStart = Math.max(0, i - 3);
      const window = lines.slice(windowStart, i + 1).join('\n');
      if (SCHEMA_KEYWORD_RE.test(window)) {
        offenses.push({
          file: rel,
          line: i + 1,
          snippet: line.trim(),
          reason:
            `toBe/toHaveLength(${FORBIDDEN}) hardcodes today's SCHEMA_VERSION next to a ` +
            `schema/migration-flavored assertion instead of comparing against the imported constant`,
        });
        continue;
      }
    }

    // Signature 3: scoped to toThrow(...) specifically -- the exact shape
    // of the tenth (previously invisible) literal. Deliberately NOT "any
    // string that mentions schema and a number" -- see file header for why
    // that broader form false-positives against this repo's legitimate
    // raw-SQL `WHERE version = <migration's own number>` literals.
    //
    // The keyword+number pair does not have to sit on the SAME line as
    // `toThrow(` -- the real historical instance of this bug
    // (tests/storage/migrate.test.ts, since fixed) called
    // `.toThrow(new RegExp(...))` with the regex's template string on the
    // NEXT line. A same-line-only check would have missed the exact bug
    // this signature exists to catch, so this looks a few lines back from
    // any keyword+number line for a `toThrow(` opener.
    if (SCHEMA_KEYWORD_RE.test(line) && numRe.test(line)) {
      const windowStart = Math.max(0, i - 3);
      const window = lines.slice(windowStart, i + 1).join('\n');
      // Require an ARGUMENT to toThrow(...) -- `.not.toThrow()` (zero-arg,
      // "does not throw at all") is a completely different assertion from
      // `.toThrow(matcher)` ("throws something matching this"), and a bare
      // `toThrow\(` substring match picks up the former too, which false-
      // positived against a legitimate nearby SQL literal (schema_version
      // WHERE clause) during this signature's reintroduce-and-verify pass.
      if (/toThrow\(\s*[^\s)]/.test(window)) {
        offenses.push({
          file: rel,
          line: i + 1,
          snippet: line.trim(),
          reason:
            `toThrow(...) assertion embeds today's SCHEMA_VERSION (${FORBIDDEN}) as a bare number ` +
            `instead of interpolating the constant (the tenth-literal shape from the original incident)`,
        });
      }
    }
  }

  return offenses;
}

describe('ADR-016 rule 1 (generalized) -- no hardcoded schema-version literal', () => {
  it(`scans src/** and tests/** for a hardcoded literal equal to today's derived SCHEMA_VERSION (${FORBIDDEN})`, () => {
    const files = SCAN_DIRS.flatMap(d => listTsFiles(join(ROOT, d)));
    const offenses = files.flatMap(scanFile);

    if (offenses.length > 0) {
      const report = offenses
        .map(o => `  ${o.file}:${o.line}\n    ${o.snippet}\n    -- ${o.reason}`)
        .join('\n\n');
      throw new Error(
        `Found ${offenses.length} hardcoded schema-version literal(s) (ADR-016 rule 1):\n\n${report}\n\n` +
          `Import SCHEMA_VERSION from src/server/lib/wire-meta.ts (or src/storage/schema-version.ts) ` +
          `instead of hardcoding ${FORBIDDEN}.`,
      );
    }
    expect(offenses).toHaveLength(0);
  });

  // A test that can't fail is worse than no test (ADR-016 rule 5's spirit,
  // applied to this test itself): assert the scan actually walked a
  // non-trivial tree and derived a real, positive value, so a future
  // refactor that accidentally makes listTsFiles() return [] doesn't leave
  // this suite vacuously green forever.
  it('sanity: the scan is not vacuous -- it walks a real tree and derives a real value', () => {
    const files = SCAN_DIRS.flatMap(d => listTsFiles(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(50);
    expect(FORBIDDEN).toBeGreaterThan(0);
  });
});
