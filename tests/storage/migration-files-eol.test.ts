/**
 * Root-cause guard for #188's migration-1 hash mismatch (DB recorded
 * `init` hash `63c76575…`, on-disk hashed to `2880ad83…`).
 *
 * migrate.ts's `migrationFileHash` (see migration-hash-crlf.test.ts and
 * migration-hash-rollback.test.ts) already makes the DAEMON tolerate a
 * CRLF checkout — it normalizes before hashing and accepts either form.
 * That is a workaround at the application layer, not a fix at the source:
 * without a `.gitattributes` rule, `migrations/*.sql` still checks out as
 * CRLF on any Windows box with the (default) `core.autocrlf=true`, which is
 * what produced the drift in the first place.
 *
 * This test pins the actual fix — `.gitattributes` forcing
 * `migrations/*.sql text eol=lf` — by asserting every migration file on
 * disk is free of CR bytes in THIS checkout. If `.gitattributes` is ever
 * removed, or a new migration file is added without going through a normal
 * `git add` (which respects the attribute), this fails loudly instead of
 * waiting for the next Windows contributor to hit the boot-refusal again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR } from '../../src/storage/schema-version.js';

describe('migration files check out as LF (.gitattributes eol=lf guard)', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));

  it('found migration files to check (test is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`migrations/${f} has no CR bytes on disk`, () => {
      const raw = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      expect(raw.includes('\r')).toBe(false);
    });
  }
});
