/**
 * tests/doctor/extract-profile-check.test.ts
 *
 * FEAT-479 AC-10 (SLICE-434): doctor's "Extraction profile" check is an
 * informational row reporting the current `distill.extractProfile` —
 * never a WARN in either profile ('engineering'/'conversational' both
 * report ok: true). Its job is the redaction-posture disclosure: switching
 * to 'conversational' does NOT change what gets redacted — src/redact/
 * index.ts only strips secrets, never non-secret personal content — so an
 * operator running the conversational profile must see that stated
 * explicitly on every `doctor` run, not just in a config.yaml comment.
 * Added per this repo's per-check test-file convention (see
 * tests/doctor/durability-gate-mode-check.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { getChecks } from '../../src/doctor/checks.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Extraction profile" check (FEAT-479 AC-10)', () => {
  it('defaults to "engineering" when extractProfile is omitted, and is always ok', async () => {
    const check = findCheck(getChecks({}), 'Extraction profile');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('engineering');
  });

  it('reports "engineering" explicitly and never WARNs', async () => {
    const check = findCheck(getChecks({ extractProfile: 'engineering' }), 'Extraction profile');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('engineering');
  });

  it('reports "conversational" and discloses the redaction posture (secrets-only, non-secret content NOT redacted, stays on-device)', async () => {
    const check = findCheck(getChecks({ extractProfile: 'conversational' }), 'Extraction profile');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('conversational');
    expect(result.message.toLowerCase()).toContain('not redacted');
    expect(result.message.toLowerCase()).toContain('on-device');
  });
});
