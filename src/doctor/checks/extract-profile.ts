import type { Check, CheckResult } from '../types.js';
import type { ExtractProfile } from '../../distill/prompts/extract.js';

// ─── Check: Extraction profile (FEAT-479 AC-10 / SLICE-434) ──────────────────

/**
 * Informational-only row (`ok: true` always — mirrors `checkDurabilityGateMode`'s
 * precedent: a deliberate, disclosed config choice is never itself a WARN).
 * Its whole job is the redaction-posture disclosure: `conversational` extracts
 * MUCH more personal detail (names, relationships, life events) than
 * `engineering` does, and `src/redact/index.ts` is unchanged either way — it
 * only strips SECRETS (tokens/keys/passwords/high-entropy strings), never
 * non-secret personal content. Every operator running `conversational`
 * should see this on every `doctor` run, not only in a config.yaml comment.
 */
export function checkExtractProfile(profile: ExtractProfile): Check {
  return {
    name: 'Extraction profile',
    async run(): Promise<CheckResult> {
      if (profile === 'conversational') {
        return {
          ok: true,
          message:
            'extraction profile: conversational — extracts personal facts/relationships/events liberally. ' +
            'Redaction is UNCHANGED (secrets only — tokens/keys/passwords); non-secret personal content is ' +
            'NOT redacted and stays on-device in the local SQLite store, same as the engineering profile ' +
            '(see FEAT-479 / src/distill/prompts/extract.ts).',
        };
      }
      return { ok: true, message: 'extraction profile: engineering (default)' };
    },
  };
}
