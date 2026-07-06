/**
 * FEAT-414: kills silent drift between src/pipeline/mock-providers.ts's
 * deterministic extraction vocabulary and tests/smoke/_fixtures/session-canonical.json.
 *
 * Before this test, the two sides were kept in lockstep only by doc
 * comments — a keyword edit on either side would silently false-negative
 * the smoke suite's fixture-derived assertions instead of failing loudly.
 * Both sides now read from the single shared vocabulary module
 * src/pipeline/mock-extraction-vocab.ts; this test asserts the fixture
 * still contains, for every rule in that module, at least one of its
 * trigger keywords — so a keyword rename/removal here fails this test
 * immediately instead of silently breaking tests/smoke/smoke.test.ts.
 *
 * Pure test-infra hygiene: does not touch or duplicate any smoke-suite
 * assertion, and never runs the mock providers or a daemon.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOCK_EXTRACTION_VOCAB } from '../../src/pipeline/mock-extraction-vocab.js';

const FIXTURE_PATH = join(process.cwd(), 'tests', 'smoke', '_fixtures', 'session-canonical.json');

interface FixtureTurn { role: string; text: string; ts?: string }
interface Fixture { turns: FixtureTurn[] }

function loadFixtureLowerText(): string {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
  return fixture.turns.map(t => t.text).join('\n').toLowerCase();
}

describe('mock-extraction-vocab <-> smoke fixture lockstep (FEAT-414)', () => {
  const fixtureLower = loadFixtureLowerText();

  it.each(MOCK_EXTRACTION_VOCAB.map(rule => [rule.id, rule] as const))(
    'fixture triggers vocab rule %s',
    (_id, rule) => {
      const triggered = rule.keywords.some(kw => fixtureLower.includes(kw));
      expect(
        triggered,
        `session-canonical.json no longer contains any of [${rule.keywords.join(', ')}] ` +
          `for vocab rule "${rule.id}" — update the fixture or the vocab in ` +
          `src/pipeline/mock-extraction-vocab.ts so they stay in lockstep.`,
      ).toBe(true);
    },
  );

  it('every vocab rule id is unique', () => {
    const ids = MOCK_EXTRACTION_VOCAB.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
