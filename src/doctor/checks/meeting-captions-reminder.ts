import type { Check, CheckResult } from '../types.js';

// ─── Check: Meeting-captions capture reminder (FEAT-491, ADR-017) ───────────

/**
 * Genuine, every-run WARN while meeting-caption capture is actively ON —
 * mirrors `checkProxyCaptureReminder` (proxy-capture-reminder.ts) exactly,
 * same rationale: ADR-017 decision 3 requires a doctor WARN row per
 * third-party-speaker capture surface so an operator (or a later audit) can
 * see at a glance which such surfaces are live, distinguishing this from an
 * aggregate auto-capture flag. Being ON is a disclosed, opt-in choice
 * (`captureSource.meetingCaptions.enabled`, default false) — that posture is
 * correct and this check doesn't second-guess it; `ok: false` here is purely
 * informational-but-unconditional for as long as the surface stays enabled,
 * same shape as the proxy-capture reminder's own doc comment explains.
 */
export function checkMeetingCaptionsReminder(meetingCaptionsEnabled: boolean): Check {
  return {
    name: 'Meeting-captions capture reminder',
    tier: 'cheap', // config-only, no I/O
    async run(): Promise<CheckResult> {
      if (!meetingCaptionsEnabled) {
        return { ok: true, message: 'meeting-captions capture: off (default)' };
      }
      return {
        ok: false,
        message:
          'meeting-captions capture is ON — every meeting caption scraped by the astramem-plugin browser ' +
          'extension (ADR-017: captures OTHER participants\' words, not just your own) is being persisted ' +
          'until you turn it off.',
        fix: 'astramem-local capture meeting-captions disable [--purge|--keep]',
      };
    },
  };
}
