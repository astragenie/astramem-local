import { describe, it, expect } from 'vitest';
import {
  groundAtomDates,
  hasUnresolvedRelativeDate,
  DATE_GROUNDING_RETRY_MARKER,
} from '../../src/distill/ground-dates.js';
import type { ReducedAtom } from '../../src/distill/stages/06-reduce.js';
import type { LLMProvider, ChatMsg, ChatResult, LLMHealth } from '../../src/contracts/llm.js';

function atom(text: string, overrides: Partial<ReducedAtom> = {}): ReducedAtom {
  return {
    type: 'fact',
    text,
    importance: 0.5,
    confidence: 0.8,
    contentHash: 'deadbeef',
    ...overrides,
  };
}

/**
 * A "well-behaved model" double: given a table of phrase -> resolution
 * (or `null` to mean "leave unchanged"), returns {"resolved_text": ...}
 * unconditionally per the module's contract. Records every user message so
 * tests can assert on what was actually sent.
 */
function makeRetryLLM(
  resolutions: Record<string, string | null>,
): { llm: LLMProvider; userMessages: string[]; systemMessages: string[]; calls: number } {
  const userMessages: string[] = [];
  const systemMessages: string[] = [];
  let calls = 0;
  const llm: LLMProvider = {
    name: 'codex-subscription' as const,
    model: 'test-model',
    async chat(msgs: ChatMsg[]): Promise<ChatResult> {
      calls++;
      const userMsg = msgs.find((m) => m.role === 'user')?.content ?? '';
      const sysMsg = msgs.find((m) => m.role === 'system')?.content ?? '';
      userMessages.push(userMsg);
      systemMessages.push(sysMsg);

      const sentenceMatch = userMsg.match(/Sentence: ([\s\S]*?)\n\nRespond with JSON\.$/);
      const sentence = sentenceMatch ? sentenceMatch[1]! : '';

      let resolved = sentence;
      for (const [phrase, replacement] of Object.entries(resolutions)) {
        if (sentence.includes(phrase)) {
          resolved = replacement === null ? sentence : sentence.replace(phrase, replacement);
          break;
        }
      }

      return {
        text: JSON.stringify({ resolved_text: resolved }),
        usage: { in: 50, out: 20, usd: 0 },
      };
    },
    async health(): Promise<LLMHealth> {
      return { ok: true, model: 'test-model', latency_ms: 0 };
    },
  };
  return { llm, userMessages, systemMessages, calls };
}

describe('hasUnresolvedRelativeDate (detection-only, never used to rewrite)', () => {
  it.each([
    'Melanie painted a sunset over a lake last year.',
    'Caroline attended a support group yesterday.',
    'They are meeting again tomorrow.',
    'The launch happened last week.',
    'We shipped this weekend.',
    'She started next month.',
    'It happened three years ago.',
    'It happened a few weeks ago.',
    'He mentioned it earlier this month.',
    'They talked about it recently.',
    'She saw him last Friday.',
  ])('matches: %s', (text) => {
    expect(hasUnresolvedRelativeDate(text)).toBe(true);
  });

  it.each([
    'This is the last chance to sign up.',
    'At last, the build passed.',
    'The last name on the list was Smith.',
    'Melanie signed up for a pottery class on 2 July 2023.',
    'Caroline lives in Berlin.',
  ])('does NOT match: %s', (text) => {
    expect(hasUnresolvedRelativeDate(text)).toBe(false);
  });
});

describe('groundAtomDates — plumbing and safety', () => {
  it('is a total no-op when sessionDateIso is absent — no call fired, atoms pass through unchanged', async () => {
    const { llm, calls } = makeRetryLLM({});
    const atoms = [atom('Melanie painted a sunset over a lake last year.')];

    const result = await groundAtomDates(atoms, undefined, llm);

    expect(result.fired).toBe(0);
    expect(result.resolved).toBe(0);
    expect(result.atoms).toEqual(atoms);
    expect(llm.chat).toBeDefined();
  });

  it('does not fire on atoms with no relative-date expression', async () => {
    const { llm } = makeRetryLLM({});
    const atoms = [atom('Caroline lives in Berlin.')];

    const result = await groundAtomDates(atoms, '2023-07-15', llm);

    expect(result.fired).toBe(0);
    expect(result.totalAtoms).toBe(1);
  });

  it('fires exactly once per matching atom and rewrites text on a genuine resolution', async () => {
    const { llm, userMessages } = makeRetryLLM({
      'last year': '2022',
    });
    const atoms = [
      atom('Melanie painted a sunset over a lake last year.'),
      atom('Caroline lives in Berlin.'), // no match — must not fire
    ];

    const result = await groundAtomDates(atoms, '2023-07-15', llm);

    expect(result.fired).toBe(1);
    expect(result.resolved).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.atoms[0]!.text).toBe('Melanie painted a sunset over a lake 2022.');
    expect(result.atoms[1]!.text).toBe('Caroline lives in Berlin.');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toContain('Session date: 2023-07-15');
  });

  it('embeds the stable marker in the system prompt (mock-routing seam)', async () => {
    const { llm, systemMessages } = makeRetryLLM({ 'last year': '2022' });
    await groundAtomDates([atom('It happened last year.')], '2023-07-15', llm);
    expect(systemMessages[0]).toContain(DATE_GROUNDING_RETRY_MARKER);
  });

  it('never touches atom.evidence — only text is replaced', async () => {
    const { llm } = makeRetryLLM({ 'last year': '2022' });
    const atoms = [
      atom('Melanie painted a sunset over a lake last year.', {
        evidence: 'Melanie: "I painted a sunset over a lake last year, it was beautiful."',
      }),
    ];

    const result = await groundAtomDates(atoms, '2023-07-15', llm);

    expect(result.atoms[0]!.text).toBe('Melanie painted a sunset over a lake 2022.');
    expect(result.atoms[0]!.evidence).toBe(
      'Melanie: "I painted a sunset over a lake last year, it was beautiful."',
    );
  });

  it('leaves every other atom field untouched (importance, confidence, type, contentHash)', async () => {
    const { llm } = makeRetryLLM({ 'last year': '2022' });
    const atoms = [
      atom('It happened last year.', { importance: 0.73, confidence: 0.61, type: 'event', contentHash: 'abc123' }),
    ];

    const result = await groundAtomDates(atoms, '2023-07-15', llm);

    expect(result.atoms[0]!.importance).toBe(0.73);
    expect(result.atoms[0]!.confidence).toBe(0.61);
    expect(result.atoms[0]!.type).toBe('event');
    expect(result.atoms[0]!.contentHash).toBe('abc123');
  });

  it('a well-behaved model declining to resolve (fabrication guard) counts as fired but not resolved', async () => {
    // Model correctly recognizes "the project's last week" is NOT session-relative
    // and returns the sentence unchanged, per its own system-prompt contract.
    const { llm } = makeRetryLLM({
      "the project's last week": null, // explicit decline
    });
    const atoms = [atom("Caroline described the project's last week as extremely stressful.")];

    const result = await groundAtomDates(atoms, '2023-07-15', llm);

    expect(result.fired).toBe(1);
    expect(result.resolved).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.atoms[0]!.text).toBe("Caroline described the project's last week as extremely stressful.");
  });

  it('malformed JSON response is a no-op fallback, not a thrown error', async () => {
    const llm: LLMProvider = {
      name: 'codex-subscription' as const,
      model: 'test-model',
      async chat(): Promise<ChatResult> {
        return { text: 'not json at all', usage: { in: 10, out: 5, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-model', latency_ms: 0 };
      },
    };
    const atoms = [atom('It happened last year.')];

    const result = await groundAtomDates(atoms, '2023-07-15', llm, { log: () => {} });

    expect(result.fired).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.resolved).toBe(0);
    expect(result.atoms[0]!.text).toBe('It happened last year.');
  });

  it('a thrown/rejected chat() call is a no-op fallback, not a propagated exception', async () => {
    const llm: LLMProvider = {
      name: 'codex-subscription' as const,
      model: 'test-model',
      async chat(): Promise<ChatResult> {
        throw new Error('network exploded');
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-model', latency_ms: 0 };
      },
    };
    const atoms = [atom('It happened last year.')];

    const result = await groundAtomDates(atoms, '2023-07-15', llm, { log: () => {} });

    expect(result.fired).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.atoms[0]!.text).toBe('It happened last year.');
  });

  it('an empty resolved_text falls back to the original text rather than blanking the atom', async () => {
    const llm: LLMProvider = {
      name: 'codex-subscription' as const,
      model: 'test-model',
      async chat(): Promise<ChatResult> {
        return { text: JSON.stringify({ resolved_text: '   ' }), usage: { in: 10, out: 5, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-model', latency_ms: 0 };
      },
    };
    const atoms = [atom('It happened last year.')];

    const result = await groundAtomDates(atoms, '2023-07-15', llm);

    expect(result.atoms[0]!.text).toBe('It happened last year.');
  });

  it('respects maxCalls — stops firing once the cap is hit, remaining atoms pass through', async () => {
    const { llm } = makeRetryLLM({ 'last year': '2022' });
    const atoms = [
      atom('First happened last year.'),
      atom('Second happened last year.'),
      atom('Third happened last year.'),
    ];

    const result = await groundAtomDates(atoms, '2023-07-15', llm, { maxCalls: 2 });

    expect(result.fired).toBe(2);
    expect(result.atoms[2]!.text).toBe('Third happened last year.'); // never fired, untouched
  });

  it('totalAtoms always reflects the full input length regardless of fire rate', async () => {
    const { llm } = makeRetryLLM({ 'last year': '2022' });
    const atoms = [
      atom('Caroline lives in Berlin.'),
      atom('It happened last year.'),
      atom('Melanie codes in TypeScript.'),
    ];

    const result = await groundAtomDates(atoms, '2023-07-15', llm);

    expect(result.totalAtoms).toBe(3);
    expect(result.fired).toBe(1);
  });
});

/**
 * Pinned regression coverage for the six adversarial cases from the
 * date-grounding-retry handoff — the exact three PR #257 fabrication
 * classes plus two extra adversarial shapes plus one genuinely-relative
 * case that MUST resolve. These mocks play a "well-behaved model" (one that
 * follows this module's own system-prompt contract) — they pin OUR
 * plumbing's contract (fired-but-declined is not an error; a real
 * resolution replaces text; evidence is never touched), not the real LLM's
 * judgment, which cannot be exercised in CI without a live call.
 *
 * The real judgment call WAS made and verified live against
 * codex-subscription (gpt-5.4-mini) — see
 * scripts/eval/date-grounding-retry-adversarial.mts, run 2026-07-13:
 * 0/5 fabrication cases fabricated, the must-resolve case resolved
 * correctly both runs, 0/30 false positives on a non-temporal control
 * batch. This block exists so a FUTURE regression in the plumbing (not the
 * model) — e.g. someone "simplifying" the fired-vs-resolved distinction, or
 * accidentally touching evidence — fails fast in CI without a live call.
 */
describe('groundAtomDates — pinned adversarial cases (mocked "well-behaved model")', () => {
  it('FABRICATION CLASS 1 (PR #257 round 1, "of <noun>" continuation) — must stay unchanged', async () => {
    const { llm } = makeRetryLLM({ "last week of the project": null });
    const text = 'Caroline described the last week of the project as extremely stressful.';
    const result = await groundAtomDates([atom(text)], '2023-07-15', llm);
    expect(result.fired).toBe(1);
    expect(result.atoms[0]!.text).toBe(text);
  });

  it('FABRICATION CLASS 2 (PR #257 round 2, Saxon genitive) — must stay unchanged', async () => {
    const { llm } = makeRetryLLM({ "last week's numbers": null });
    const text = "The project's last week's numbers were the worst on record.";
    const result = await groundAtomDates([atom(text)], '2023-07-15', llm);
    expect(result.fired).toBe(1);
    expect(result.atoms[0]!.text).toBe(text);
  });

  it('FABRICATION CLASS 3 (PR #257 round 3, pronoun possessive) — must stay unchanged', async () => {
    const { llm } = makeRetryLLM({ 'last week': null });
    const text = 'Her last week was overwhelming.';
    const result = await groundAtomDates([atom(text)], '2023-07-15', llm);
    expect(result.fired).toBe(1);
    expect(result.atoms[0]!.text).toBe(text);
  });

  it('ADVERSARIAL — re-anchoring preposition ("before the launch") — must stay unchanged', async () => {
    const { llm } = makeRetryLLM({ 'last week before': null });
    const text = 'The last week before the launch was chaos.';
    const result = await groundAtomDates([atom(text)], '2023-07-15', llm);
    expect(result.fired).toBe(1);
    expect(result.atoms[0]!.text).toBe(text);
  });

  it('ADVERSARIAL — adjective interposition ("exhausting last month") — must stay unchanged', async () => {
    const { llm } = makeRetryLLM({ 'last month': null });
    const text = "The team's exhausting last month was finally over.";
    const result = await groundAtomDates([atom(text)], '2023-07-15', llm);
    expect(result.fired).toBe(1);
    expect(result.atoms[0]!.text).toBe(text);
  });

  it('MUST RESOLVE — genuinely session-relative ("I saw her last week") — must change to WEEK granularity, not a specific day', async () => {
    // GRANULARITY BUG (found in review, 2026-07-13): a live run against this
    // exact sentence returned a DIFFERENT specific day on each of two runs
    // ("3 July 2023" then "8 July 2023") — proof the model was guessing a
    // day the source text never specified. The correct resolution is
    // week-granularity, matching the source phrase's own granularity.
    const { llm } = makeRetryLLM({ 'last week': 'the week before 15 July 2023' });
    const text = 'I saw her last week.';
    const result = await groundAtomDates([atom(text)], '2023-07-15', llm);
    expect(result.fired).toBe(1);
    expect(result.resolved).toBe(1);
    expect(result.atoms[0]!.text).toBe('I saw her the week before 15 July 2023.');
    expect(result.atoms[0]!.text).not.toBe(text);
    // Must NOT contain a bare day-of-month date shape (D Month YYYY without
    // "week"/"month"/"weekend" context) — the granularity regression guard.
    expect(result.atoms[0]!.text).not.toMatch(/^I saw her \d{1,2} \w+ \d{4}\.$/);
  });

  it('evidence is untouched across all six pinned cases', async () => {
    const evidenceText = 'verbatim transcript quote — must never be rewritten';
    const { llm } = makeRetryLLM({ 'last week': 'the week before 15 July 2023' });
    const result = await groundAtomDates(
      [atom('I saw her last week.', { evidence: evidenceText })],
      '2023-07-15',
      llm,
    );
    expect(result.atoms[0]!.evidence).toBe(evidenceText);
  });
});

/**
 * GRANULARITY regression coverage (2026-07-13, found in review — see
 * ground-dates.ts's module doc comment "GRANULARITY BUG"). A
 * week/month/year-granularity source expression must resolve to a
 * week/month/year-granularity output, never collapsed to a specific day.
 * Only genuinely day-determining expressions (yesterday/today/tomorrow, a
 * named weekday, "N days ago") may resolve to a specific day. These mocks
 * again play a "well-behaved model" — they pin the plumbing/contract, not
 * the real model's arithmetic, which was verified live (see
 * scripts/eval/date-grounding-retry-adversarial.mts).
 */
describe('groundAtomDates — granularity preservation (week/month/year must not collapse to a day)', () => {
  it('"last week" resolves to a week-reference phrase, never a specific day', async () => {
    const { llm } = makeRetryLLM({ 'last week': 'the week before 15 July 2023' });
    const result = await groundAtomDates([atom('It happened last week.')], '2023-07-15', llm);
    expect(result.atoms[0]!.text).toBe('It happened the week before 15 July 2023.');
    expect(result.atoms[0]!.text).toContain('week');
  });

  it('"last month" resolves to Month + Year only, never a day', async () => {
    const { llm } = makeRetryLLM({ 'last month': 'June 2023' });
    const result = await groundAtomDates([atom('It happened last month.')], '2023-07-15', llm);
    expect(result.atoms[0]!.text).toBe('It happened June 2023.');
    expect(result.atoms[0]!.text).not.toMatch(/\b\d{1,2} \w+ \d{4}\b/); // no "D Month YYYY" shape
  });

  it('"last year" resolves to the bare year only, never a month or day', async () => {
    const { llm } = makeRetryLLM({ 'last year': '2022' });
    const result = await groundAtomDates([atom('It happened last year.')], '2023-07-15', llm);
    expect(result.atoms[0]!.text).toBe('It happened 2022.');
  });

  it('"yesterday" (genuinely day-determining) IS allowed to resolve to a specific day', async () => {
    const { llm } = makeRetryLLM({ yesterday: '14 July 2023' });
    const result = await groundAtomDates([atom('It happened yesterday.')], '2023-07-15', llm);
    expect(result.atoms[0]!.text).toBe('It happened 14 July 2023.');
  });

  it('"last Friday" (named weekday, genuinely day-determining) IS allowed to resolve to a specific day', async () => {
    const { llm } = makeRetryLLM({ 'last Friday': '14 July 2023' });
    const result = await groundAtomDates([atom('It happened last Friday.')], '2023-07-15', llm);
    expect(result.atoms[0]!.text).toBe('It happened 14 July 2023.');
  });
});
