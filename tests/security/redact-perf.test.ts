/**
 * FEAT-459 perf smoke: stage-0 redaction (src/redact/index.ts) sits on the
 * hot ingest path (every POST /ingest/transcript and /remember call runs it
 * synchronously before the DB write), so the compound-label regex change
 * (detectors.ts generic_credential: `\b` -> `(?<![A-Za-z])`) must not
 * regress latency by an order of magnitude. No dedicated redaction perf
 * harness exists yet (scripts/perf/* benchmarks full HTTP endpoints, not
 * stage-0 in isolation) — this is a self-contained micro-benchmark.
 *
 * It logs concrete p50/p95/mean figures (not just pass/fail) so a
 * regression is visible in CI output, per FEAT-459 AC-5.
 */

import { describe, it, expect } from 'vitest';
import { redactText } from '../../src/redact/index.js';
import { summarize, type LatencyStats } from '../../scripts/perf/lib/stats.js';

// Representative auto-capture-shaped transcript turn: mixed prose, an env
// dump, and several secret types — the shape stage-0 sees most often per
// the FEAT-455 spike (docs/specs/FEAT-455-spike-results.md findings 1-3).
function buildRepresentativePayload(): string {
  const turns = [
    'Let me walk through the deploy config with you.',
    [
      'NODE_ENV=production',
      'PORT=7777',
      'LOG_LEVEL=info',
      'GITHUB_TOKEN=ghp_HKNQTWZcfilorux0369CFILORUXadgjmpsvy',
      'DATABASE_URL=postgres://svcuser:sup3rs3cr3t@db.internal:5432/app',
      'INTERNAL_SECRET=abc123',
      'OPENAI_API_KEY=sk-proj-9f8e7d6c5b4a3210',
      'AWS_ACCESS_KEY=AKIAHSDOZALWHS3EPALW',
    ].join('\n'),
    'That should cover the env. The rest of this turn is unrelated prose '.repeat(20),
    'Here is a JWT for testing: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'And a random high-entropy blob: zT9kQ2vXmN4pR8wL1sYbF6cH3jD0eAgi embedded in prose.',
  ];
  return turns.join('\n\n');
}

describe('redactText — perf smoke (FEAT-459 AC-5)', () => {
  it('processes a representative auto-capture transcript payload without an ' +
     'order-of-magnitude latency regression', () => {
    const payload = buildRepresentativePayload();
    const iterations = 200;
    const warmup = 20;
    const samples: number[] = [];

    for (let i = 0; i < warmup + iterations; i++) {
      const t0 = performance.now();
      redactText(payload);
      const ms = performance.now() - t0;
      if (i >= warmup) samples.push(ms);
    }

    const stats: LatencyStats = summarize(samples);
    // eslint-disable-next-line no-console
    console.log(
      `[FEAT-459 perf smoke] redactText over ${payload.length}-char payload, ` +
      `n=${stats.n}: p50=${stats.p50.toFixed(3)}ms p95=${stats.p95.toFixed(3)}ms ` +
      `mean=${stats.mean.toFixed(3)}ms max=${stats.max.toFixed(3)}ms`,
    );

    // Generous order-of-magnitude guard, not a tight budget: stage-0 on a
    // multi-KB transcript should stay well under 20ms p95 on any dev/CI
    // machine. A regression that matters (e.g. catastrophic backtracking
    // introduced by a bad regex) blows past this by 10-100x, not 20%.
    expect(stats.p95).toBeLessThan(20);

    // Sanity: the payload's secrets actually got redacted (perf numbers on
    // a no-op path would be meaningless).
    const { events } = redactText(payload);
    expect(events.length).toBeGreaterThanOrEqual(6);
  });

  it('logs a direct before/after comparison of the changed generic_credential ' +
     'regex (old \\b-anchored vs new lookbehind-anchored) over the same payload', () => {
    const payload = buildRepresentativePayload();
    const iterations = 500;

    // "Before" — the pre-FEAT-459 \b-anchored label pattern (detectors.ts,
    // reconstructed here rather than via git checkout so this stays a pure
    // in-process comparison with no working-tree side effects).
    const oldSource = '\\b(?:api[_-]?key|secret|token|password|passwd|pwd)\\s*[:=]\\s*(\\S+)';
    // "After" — the current lookbehind-anchored pattern actually shipped.
    const newSource = '(?<![A-Za-z])(?:api[_-]?key|secret|token|password|passwd|pwd)\\s*[:=]\\s*(\\S+)';

    const bench = (source: string): LatencyStats => {
      const samples: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const re = new RegExp(source, 'gi');
        const t0 = performance.now();
        let m: RegExpExecArray | null;
        while ((m = re.exec(payload)) !== null) {
          if (re.lastIndex === m.index) re.lastIndex++;
        }
        samples.push(performance.now() - t0);
      }
      return summarize(samples);
    };

    const before = bench(oldSource);
    const after = bench(newSource);
    // eslint-disable-next-line no-console
    console.log(
      `[FEAT-459 perf smoke] generic_credential regex before(\\b)=${before.mean.toFixed(4)}ms ` +
      `vs after(lookbehind)=${after.mean.toFixed(4)}ms mean per pass ` +
      `(delta=${(after.mean - before.mean).toFixed(4)}ms)`,
    );

    // The lookbehind form does strictly more label-side work per candidate
    // position; guard against that turning into a pathological blowup
    // rather than the expected small constant-factor delta.
    expect(after.mean).toBeLessThan(Math.max(before.mean * 5, 1));
  });
});
