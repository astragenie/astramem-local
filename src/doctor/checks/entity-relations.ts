import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import type { ExtractProfile } from '../../distill/prompts/extract.js';
import { totalRelationGuardDrops } from '../../storage/relation-guard-log.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Entity relations extraction (FEAT-481 SLICE-430) ────────────────

/**
 * "Built, wired, never invoked" canary for the entity-to-entity relation
 * pipeline (FEAT-481/SLICE-435: AtomRelationSchema in the extraction prompt
 * -> filterAtomRelations (05-extract.ts) -> stage 8's write into
 * `entity_relations`). Doctor is the only place that can catch "the code
 * compiles and unit tests pass, but distilling a real transcript never
 * actually produces a row" — see the design doc's own framing of this exact
 * failure mode for this repo.
 *
 * `relations[]` guidance was added to the ENGINEERING prompt only
 * (src/distill/prompts/extract.ts's SLICE-435 update comment — the
 * conversational profile, SLICE-434, was deliberately not extended to
 * cover it). So a zero row count under `extractProfile: 'conversational'`
 * is not evidence of anything broken — this check stays informational in
 * that case regardless of activity, rather than false-alarming on a profile
 * that was never asked to produce relations in the first place.
 *
 * Under the engineering profile (the default), gated on the same
 * MEANINGFUL_USAGE_THRESHOLD floor `checkAutoCapture`/
 * `checkUsefulnessFeedbackLoop` use — a brand-new or low-activity install
 * legitimately has zero relations and must not warn. Once that floor is
 * crossed with zero `entity_relations` rows, `relation_guard_drops` (029,
 * see src/storage/relation-guard-log.ts) is the tie-breaker: drops > 0 means
 * the model IS emitting relations and the guard is dropping every one
 * (predicate/hallucination/shape issue, or a model-capability gap);
 * drops == 0 too means the model itself never emits a `relations[]` entry
 * at all — both are folded into one WARN message (the fix guidance covers
 * both causes) since the operator-facing remedy — check the extraction
 * model / look at debug logs — is the same either way.
 */
export function checkEntityRelations(
  dataDir: string,
  extractProfile: ExtractProfile,
  encryptionEnabled: boolean,
): Check {
  return {
    name: 'Entity relations extraction',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'entity relations: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        const totalRow = db.prepare('SELECT COUNT(*) AS n FROM entity_relations').get() as { n: number };
        const total = totalRow.n;
        const recent7dRow = db
          .prepare('SELECT COUNT(*) AS n FROM entity_relations WHERE created_at >= ?')
          .get(since) as { n: number };
        const recent7d = recent7dRow.n;
        const newestRow = db.prepare('SELECT MAX(created_at) AS ts FROM entity_relations').get() as
          | { ts: number | null }
          | undefined;
        const newestAgeH = newestRow?.ts ? ((Date.now() - newestRow.ts) / 3_600_000).toFixed(1) : null;

        if (total > 0) {
          const ageStr = newestAgeH !== null ? `, newest ${newestAgeH}h old` : '';
          return {
            ok: true,
            message: `entity relations: ${total} row(s) total (${recent7d} in last 7d${ageStr})`,
          };
        }

        // total === 0 from here down.
        if (extractProfile === 'conversational') {
          return {
            ok: true,
            message:
              'entity relations: 0 rows — expected under the conversational extraction profile ' +
              '(relations[] guidance is engineering-profile only, see FEAT-481 SLICE-435).',
          };
        }

        const recentMemoriesRow = db
          .prepare('SELECT COUNT(*) AS n FROM memories WHERE created_at >= ?')
          .get(since) as { n: number };
        const recentMemories = recentMemoriesRow.n;

        if (recentMemories < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `entity relations: 0 rows — not enough distill activity yet to judge (${recentMemories} ` +
              `memories in last 7d, below the ${MEANINGFUL_USAGE_THRESHOLD} floor)`,
          };
        }

        const guardDrops7d = totalRelationGuardDrops(db, since);

        return {
          ok: false,
          message:
            `relations extraction is wired but has never produced a row — check model capability or guard ` +
            `drops (${recentMemories} memories distilled in last 7d, 0 entity_relations rows, ` +
            `${guardDrops7d} guard-drop event(s) recorded in the same window — ` +
            (guardDrops7d > 0
              ? 'the model IS emitting relations and the guard is dropping every one.'
              : 'the model itself is not emitting any relations[] entries.') +
            ')',
          fix:
            'Check debug logs for "relations[]: dropped" lines (src/distill/stages/05-extract.ts) to see which ' +
            'guard is firing, or confirm the extraction model actually supports the relations[] JSON shape in ' +
            'the engineering prompt.',
        };
      } catch (err) {
        // The query itself failed — did NOT verify entity relations are
        // healthy (this is the same failure shape issue #200 was about: a
        // canary that can report green without having actually checked).
        return { ok: true, inconclusive: true, message: `entity relations check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
