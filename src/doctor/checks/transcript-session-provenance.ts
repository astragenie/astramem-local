import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Transcript/session provenance (FEAT-485) ─────────────────────────

/**
 * Companion to `checkEvidenceProvenance` for the OTHER two provenance fields
 * the same live-store audit found near-absent: `transcript_ref`
 * (`memories.source_hash`, surfaced via why_memory — src/server/queries/
 * provenance.ts) and `session` (`memories.session_id` resolved against
 * `sessions`). Root-caused 2026-07-13 (FEAT-485): tracing the ingest paths
 * (hook-built envelopes -> `POST /ingest/transcript` -> distillHandler ->
 * PipelineContext -> embedAndIndex's `insertWithCreateEvent` call, plus the
 * FEAT-449 spool-drain path, which reuses the exact same
 * `ingestCanonicalTranscript` function) shows `session_id` and `source_hash`
 * ARE threaded correctly end-to-end on every row that goes through that
 * pipeline — `git log -S` on the relevant lines shows no regression. What
 * DOES lack both fields, always, by design, since its very first commit
 * (`cd7849d`): the `remember` MCP tool and the Anthropic memory-tool adapter
 * (src/memory-tool/adapter.ts) — direct-insert paths with no transcript
 * context to attach (ADR-009 "born-at-scope"). So a low overall rate across
 * ALL memories is expected and not itself a bug; what WOULD be a real
 * pipeline regression is a source_hash-tagged (i.e. genuinely distill-
 * sourced) row missing session_id — that should never happen given
 * distillHandler always supplies a non-null `session_id` from the job
 * payload. This check isolates exactly that slice instead of conflating it
 * with the (expected) direct-insert gap.
 */
export function checkTranscriptSessionProvenance(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Transcript/session provenance',
    // 'full' — same unindexed corpus-scale scan over `memories` that
    // checkEntityRelations/checkEvidenceProvenance are on this tier for.
    tier: 'full',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'transcript/session provenance: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        // Distill-sourced rows only (source_hash IS NOT NULL) — the slice
        // that actually went through the transcript-ingest pipeline and so
        // SHOULD always carry session_id. Direct-insert rows (remember()/
        // memory-tool) are excluded here on purpose — see doc comment above.
        const distillSourcedRow = db
          .prepare(`SELECT COUNT(*) AS n FROM memories WHERE created_at >= ? AND source_hash IS NOT NULL`)
          .get(since) as { n: number };
        const distillSourced = distillSourcedRow.n;

        if (distillSourced < MEANINGFUL_USAGE_THRESHOLD) {
          const allRecentRow = db
            .prepare(`SELECT COUNT(*) AS n FROM memories WHERE created_at >= ?`)
            .get(since) as { n: number };
          return {
            ok: true,
            message:
              `transcript/session provenance: only ${distillSourced} distill-sourced memories in last 7d ` +
              `(${allRecentRow.n} total, any origin), below the ${MEANINGFUL_USAGE_THRESHOLD} floor to judge — ` +
              'note a low distill-sourced count relative to the total is expected when remember()/memory-tool ' +
              'direct-insert (no transcript context by design, ADR-009) is the dominant recent write path.',
          };
        }

        const missingSessionRow = db
          .prepare(
            `SELECT COUNT(*) AS n FROM memories WHERE created_at >= ? AND source_hash IS NOT NULL AND session_id IS NULL`,
          )
          .get(since) as { n: number };

        if (missingSessionRow.n === 0) {
          return {
            ok: true,
            message: `transcript/session provenance: all ${distillSourced} distill-sourced memories in last 7d carry a session_id`,
          };
        }

        return {
          ok: false,
          message:
            `transcript/session provenance: ${missingSessionRow.n}/${distillSourced} distill-sourced memories in ` +
            `last 7d are missing session_id — this IS a pipeline regression (distillHandler should always supply ` +
            'a non-null session_id from the job payload); check src/pipeline/handlers/distill.ts and ' +
            'src/distill/stages/08-embed-index.ts for a broken threading path.',
          fix: 'Trace ctx.sessionId from src/pipeline/handlers/distill.ts through src/distill/pipeline.ts to 08-embed-index.ts\'s insertWithCreateEvent call.',
        };
      } catch (err) {
        // Informational failure mode — never fail doctor over a metric query
        // error, consistent with the other read-only DB checks in this
        // registry (see checkEntityRelations).
        return { ok: true, inconclusive: true, message: `transcript/session provenance check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
