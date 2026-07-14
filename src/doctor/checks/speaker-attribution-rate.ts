import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS, MEANINGFUL_USAGE_THRESHOLD } from './shared.js';

// ─── Check: Speaker attribution rate (FEAT-505 AC-4) ─────────────────────────

/**
 * Minimum acceptable fraction of recent meeting-captions memories carrying a
 * non-null `speaker_label`. Set well below 1.0 on purpose: `attributeSpeaker`
 * (src/distill/attribute-speaker.ts) is deliberately precision-biased —
 * it returns `null` rather than guess whenever the LLM's evidence excerpt
 * doesn't clear the fuzzy-match confidence threshold or a fuzzy match is
 * ambiguous between two candidate speakers (FEAT-505 AC-3's misattribution
 * guard). A meaningful fraction of atoms legitimately having no evidence at
 * all (an "optional" LLM field the model doesn't always populate — see
 * checkEvidenceProvenance's own floor/rationale, src/doctor/checks/
 * evidence-provenance.ts) or a genuinely ambiguous evidence excerpt is
 * EXPECTED, not a bug. This floor exists to catch the FEAT-505 regression
 * shape specifically: attribution silently going to ~0% across the board
 * (e.g. `attribute-speaker.ts` reverted to literal-substring-only, or
 * `ctx.sourceText` stops being threaded through — see 08-embed-index.ts's
 * `speaker_label: ctx.sourceText ? attributeSpeaker(...) : null` line), not
 * "why isn't every atom attributed."
 */
const ATTRIBUTION_RATE_WARN_FLOOR = 0.15;

/**
 * Denominator scope: `capture_source = 'meeting_captions'` only — the one
 * source where per-turn `[Speaker Name]` markers exist at all
 * (flatten-turns.ts). Every other capture source has no third-party speaker
 * identity to recover (auto_capture/hook_close/proxy are the operator's own
 * single-user sessions), so including them would only dilute the rate with
 * atoms `attributeSpeaker` was never going to label — the FEAT-505 spec's
 * own "atoms-with-speaker / caption atoms" framing (AC-4), not "/ all
 * atoms."
 *
 * Mirrors `checkEvidenceProvenance`'s shape (same SEVEN_DAYS_MS window, same
 * MEANINGFUL_USAGE_THRESHOLD gate, same "no DB yet" / "not enough activity"
 * / query-error-is-informational idiom) rather than `checkEntityLinkRate`'s
 * COUNT-tail — meeting-captions capture is opt-in and off by default
 * (`captureSource.meetingCaptions.enabled`), so a calendar window is in no
 * danger of the straddled-bucket failure mode that motivated the COUNT-tail
 * choice there (issue #200 had thousands of memories/day; this source does
 * not).
 */
export function checkSpeakerAttributionRate(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Speaker attribution rate',
    // 'full' — same unindexed corpus-scale scan over `memories` that
    // checkEvidenceProvenance is on this tier for (see its own comment).
    tier: 'full',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'speaker attribution rate: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;

        const captionRow = db
          .prepare(`SELECT COUNT(*) AS n FROM memories WHERE created_at >= ? AND capture_source = 'meeting_captions'`)
          .get(since) as { n: number };
        const captionRecent = captionRow.n;

        if (captionRecent < MEANINGFUL_USAGE_THRESHOLD) {
          return {
            ok: true,
            message:
              `speaker attribution rate: only ${captionRecent} meeting-captions memories in last 7d, below the ` +
              `${MEANINGFUL_USAGE_THRESHOLD} floor — not enough activity to judge yet`,
          };
        }

        const withSpeakerRow = db
          .prepare(
            `SELECT COUNT(*) AS n FROM memories WHERE created_at >= ? AND capture_source = 'meeting_captions' ` +
              `AND speaker_label IS NOT NULL AND TRIM(speaker_label) != ''`,
          )
          .get(since) as { n: number };
        const rate = withSpeakerRow.n / captionRecent;
        const pct = (rate * 100).toFixed(1);

        if (rate >= ATTRIBUTION_RATE_WARN_FLOOR) {
          return {
            ok: true,
            message: `speaker attribution rate: ${withSpeakerRow.n}/${captionRecent} (${pct}%) of recent meeting-captions memories carry a speaker_label`,
          };
        }

        return {
          ok: false,
          message:
            `speaker attribution rate: only ${withSpeakerRow.n}/${captionRecent} (${pct}%) of recent meeting-` +
            `captions memories carry a speaker_label (floor ${(ATTRIBUTION_RATE_WARN_FLOOR * 100).toFixed(0)}%) — ` +
            'attribution is precision-biased by design (FEAT-505 AC-3: a wrong speaker is worse than none), so ' +
            'some null rate is expected, but a rate this low across a meaningful sample suggests attribution ' +
            'itself may be broken (evidence excerpts missing, ctx.sourceText not threaded, or the fuzzy-match ' +
            'threshold regressed), not just individually ambiguous atoms.',
          fix:
            'Check that ctx.sourceText is populated for meeting-captions distill runs (src/distill/stages/08-' +
            'embed-index.ts) and that atoms carry a non-empty `evidence` excerpt (see "Evidence provenance" row) ' +
            '— attribute-speaker.ts cannot attribute an atom with no evidence at all.',
        };
      } catch (err) {
        // Informational failure mode — never fail doctor over a metric query
        // error, consistent with the other read-only DB checks in this
        // registry (see checkEvidenceProvenance).
        return { ok: true, inconclusive: true, message: `speaker attribution rate check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
