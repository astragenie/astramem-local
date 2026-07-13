/**
 * `astramem-local entity-purge-junk [--yes] [--json]`
 *
 * Deletes `entities` rows that the write-path guard would reject today but that
 * were written before it existed (issue #207). Complements
 * `entity-backfill` — that one ADDS entity links to old memories, this one
 * REMOVES garbage names. Neither ever touches a memory's text.
 *
 * PREVIEW IS THE DEFAULT. `--yes` is required to actually delete: this mutates
 * the user's production memory store irreversibly, and a mistyped flag must
 * preview rather than destroy.
 */

import { openRuntimeDb } from './open-runtime-db.js';
import { purgeJunkEntities } from '../entity/purge-junk.js';

export function entityPurgeJunkCommand(args: string[]): void {
  const jsonMode = args.includes('--json');
  const apply = args.includes('--yes');

  const { db } = openRuntimeDb();
  try {
    const result = purgeJunkEntities(db, { dryRun: !apply });

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.junk.length === 0) {
      console.log(`entity-purge-junk: scanned ${result.scanned} entities — no junk found.`);
      return;
    }

    const byReason = new Map<string, number>();
    for (const j of result.junk) byReason.set(j.reason, (byReason.get(j.reason) ?? 0) + 1);

    console.log(
      `${apply ? 'PURGED' : 'DRY RUN'} — ${result.junk.length} junk entit${result.junk.length === 1 ? 'y' : 'ies'} ` +
        `of ${result.scanned} scanned (${((result.junk.length / result.scanned) * 100).toFixed(1)}%)\n`,
    );
    for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${reason}`);
    }

    console.log('\n  sample:');
    for (const j of result.junk.slice(0, 12)) {
      const k = j.kind ?? '(no kind)';
      console.log(
        `    ${JSON.stringify(j.name).padEnd(16)} kind=${k.padEnd(10)} ${j.reason}` +
          `  (${j.links} link${j.links === 1 ? '' : 's'}, ${j.relations} relation${j.relations === 1 ? '' : 's'})`,
      );
    }
    if (result.junk.length > 12) console.log(`    ... and ${result.junk.length - 12} more`);

    // The one user-visible consequence, stated plainly rather than buried.
    console.log(
      `\n  ${result.memoriesLeftUnlinked} memor${result.memoriesLeftUnlinked === 1 ? 'y' : 'ies'} would be left with ZERO entities.`,
    );
    console.log(
      '  Those memories are NOT deleted — text and embeddings are untouched and they stay fully\n' +
        '  searchable (entity linkage feeds ranking only via the zeta fusion term, which ships at 0).\n' +
        '  They will, however, start counting toward the doctor "Entity link rate" unlinked tally.',
    );

    if (apply) {
      console.log(
        `\n  DELETED: ${result.deleted} entit${result.deleted === 1 ? 'y' : 'ies'}, ` +
          `${result.linksDeleted} memory link(s), ${result.relationsDeleted} relation(s) (FK cascade).`,
      );
    } else {
      console.log('\n  Nothing was deleted. Re-run with --yes to apply.');
    }
  } finally {
    db.close();
  }
}
