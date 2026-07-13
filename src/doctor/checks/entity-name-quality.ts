import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import { totalEntityGuardDrops } from '../../storage/entity-guard-log.js';
import { classifyJunkEntityName } from '../../distill/stages/05-extract.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS } from './shared.js';

// ─── Check: Entity name quality (issue #207) ─────────────────────────────────

/**
 * Measures the junk rate already sitting in the `entities` table — a bare
 * issue/PR reference ("#110"), a bare number ("123"), or a name below the
 * length floor (classifyJunkEntityName, src/distill/stages/05-extract.ts,
 * the same rule filterAtomEntities enforces on NEW writes going forward).
 *
 * This is deliberately a snapshot of EXISTING rows, not just an activity
 * counter: issue #207 was filed against a live corpus (4,221 entities, an
 * unknown but non-trivial junk fraction) that the forward-only guard added
 * alongside this check does NOT retroactively clean — `EntityRepo.upsert` is
 * first-writer-wins on `kind` and never revisits a name once it exists. A
 * canary that only reported "0 drops this week" would silently miss that the
 * pre-existing junk is still sitting there and still polluting any future ζ
 * (zeta) ranking sweep — the exact "canary measures the wrong thing" failure
 * #200 documents.
 *
 * Gated on a minimum total-entity floor (mirrors the MEANINGFUL_USAGE_
 * THRESHOLD spirit other checks use) so a fresh/near-empty install's small
 * sample size doesn't produce a noisy WARN on 1-2 entities.
 */
const MIN_ENTITIES_FOR_JUNK_RATE = 20;

export function checkEntityNameQuality(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Entity name quality',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'entity name quality: no DB yet' };
      }

      // `let db` OUTSIDE the try + close in `finally` — the canonical shape from
      // PR #208. Declaring it INSIDE try means a thrown query never reaches
      // db.close() and leaks the readonly handle (#208 fixed exactly this at 11
      // sites; this check, written the same day, reintroduced it).
      let db: Awaited<ReturnType<typeof openProductionDbReadonly>> | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        // Select `kind` too: classifyJunkEntityName is kind-aware (a
        // one-character `tech` like "C"/"R" is legitimate; a one-character
        // repo/actor/org is not). Selecting only `name` would apply a DIFFERENT
        // rule here than the write-path guard uses — the canary and the guard
        // must agree, or the measured junk rate is measuring nothing.
        const rows = db
          .prepare('SELECT name, kind FROM entities')
          .all() as Array<{ name: string; kind: string | null }>;
        const total = rows.length;
        const drops7d = totalEntityGuardDrops(db, since);

        if (total === 0) {
          return { ok: true, message: 'entity name quality: no entities yet' };
        }

        const junkCount = rows.filter(
          (r) => classifyJunkEntityName(r.name, r.kind ?? undefined) !== null,
        ).length;

        if (total < MIN_ENTITIES_FOR_JUNK_RATE) {
          return {
            ok: true,
            message:
              `entity name quality: ${junkCount}/${total} junk — too few entities to judge a rate yet ` +
              `(${drops7d} guard-drop(s) recorded in last 7d)`,
          };
        }

        if (junkCount === 0) {
          return {
            ok: true,
            message: `entity name quality: 0/${total} existing entities are junk (${drops7d} guard-drop(s) in last 7d)`,
          };
        }

        const ratePct = ((junkCount / total) * 100).toFixed(1);
        return {
          ok: false,
          message:
            `entity name quality: ${junkCount}/${total} (${ratePct}%) existing entities are junk ` +
            `(bare issue/PR ref, bare number, or below the length floor) — the forward guard ` +
            `(filterAtomEntities, issue #207) blocks NEW junk from being written (${drops7d} dropped ` +
            `in last 7d) but does not retroactively clean rows written before it existed.`,
          fix:
            'Existing junk entities do not self-correct — a one-off cleanup pass over the `entities` table ' +
            '(purging rows matching classifyJunkEntityName in src/distill/stages/05-extract.ts) is a separate, ' +
            'not-yet-built follow-up if this rate matters before running a ζ (zeta) ranking sweep.',
        };
      } catch (err) {
        // INCONCLUSIVE, not ok:true. A check whose own query threw has NOT
        // observed a healthy system — it has observed nothing. Returning
        // `ok: true` here is indistinguishable from "genuinely clean", which is
        // the precise bug ADR-015 forbids and PR #208 fixed at 9 other checks.
        // This check — written the same day, to enforce that very ADR —
        // reintroduced it. The failing shape is the DEFAULT shape.
        return {
          ok: true,
          inconclusive: true,
          message: `entity name quality: CHECK FAILED TO RUN (not a clean bill of health): ${err}`,
        };
      } finally {
        db?.close();
      }
    },
  };
}
