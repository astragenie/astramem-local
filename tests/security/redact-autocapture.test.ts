/**
 * FEAT-455 spike (ADR-012 checklist #3): secrets-pattern coverage against
 * AUTO-CAPTURED payload shapes specifically — as opposed to
 * tests/security/redact.test.ts's manual-session-end-hook-shaped fixtures.
 *
 * Auto-capture (hook-tap, denser sampling per ADR-012 decision 1) changes two
 * things about what reaches `redactText`, relative to today's
 * session_end-only capture:
 *   1. Frequency/timing — turns can be captured mid-conversation, including
 *      a turn whose assistant text is still streaming (partial/truncated).
 *   2. Shape — env-var-style KEY=VALUE dumps and connection strings pasted
 *      into a user/assistant turn are more likely to recur across many
 *      short captured turns rather than once in a single long transcript.
 *
 * This suite does NOT re-test what tests/security/redact.test.ts already
 * covers (the 25+ true-positive/false-positive table). It targets the
 * DELTA: does stage-0 redaction still hold under auto-capture's shapes and
 * frequency, or are there classes it misses? Per the dispatch brief:
 * "honest findings > green tests" — gaps found here are asserted as gaps
 * (documented, not silently glossed over), not worked around.
 */

import { describe, it, expect } from 'vitest';
import { redactText } from '../../src/redact/index.js';

const GHP_TOKEN = 'ghp_HKNQTWZcfilorux0369CFILORUXadgjmpsvy';
const AWS_KEY = 'AKIAHSDOZALWHS3EPALW';

// ---------------------------------------------------------------------------
// 1. High-frequency re-capture: same secret across a burst of short turns
//    (what denser per-turn/short-interval sampling produces — ADR-012
//    decision 1 tier 1). Confirms redaction is stable per-turn at the new
//    frequency, and that the existing determinism guarantee (same secret ->
//    same hash8) holds across a realistic auto-capture burst, not just two
//    texts as the base suite checks.
// ---------------------------------------------------------------------------

describe('auto-capture shape — burst of short turns re-sending the same secret', () => {
  it('redacts consistently across a 5-turn burst (denser sampling of one long response)', () => {
    const turns = [
      'Let me check the env first.',
      `export AWS_KEY_LEGACY=${AWS_KEY}`,
      `Confirmed, ${AWS_KEY} is the one in the deploy script.`,
      'Rotating it now.',
      `Old value ${AWS_KEY} has been revoked.`,
    ];
    const results = turns.map(t => redactText(t));
    const hash8s = results
      .flatMap(r => r.events)
      .filter(e => e.type === 'aws_access_key')
      .map(e => e.hash8);
    expect(hash8s.length).toBe(3); // turns 2, 3, 5 contain the key
    expect(new Set(hash8s).size).toBe(1); // same secret -> same placeholder every time
    for (const r of results) expect(r.text).not.toContain(AWS_KEY);
  });
});

// ---------------------------------------------------------------------------
// 2. Partial / mid-stream turn text — auto-capture (denser sampling) can
//    observe a turn BEFORE the model has finished producing it, unlike
//    today's session_end/subagent_stop capture which only ever reads a
//    finished transcript. A secret can be truncated mid-token.
// ---------------------------------------------------------------------------

describe('auto-capture shape — partial/truncated turn text', () => {
  it('a labeled truncated token ("token=<partial>") IS still caught, but by the ' +
     'generic_credential fallback, not the vendor-specific github_token detector ' +
     '— the label is doing the work, not pattern completeness', () => {
    // Only 16 of GHP_TOKEN's ~38 chars after the "ghp_" prefix are present, as
    // if captured mid-generation. github_token requires >=20 chars after the
    // prefix, so it does NOT match this fragment on its own merit.
    const partial = `Found it: token=${GHP_TOKEN.slice(0, 20)}`;
    const { text, events } = redactText(partial);
    expect(events.some(e => e.type === 'github_token')).toBe(false); // too short for the vendor pattern
    expect(events.some(e => e.type === 'generic_credential')).toBe(true); // rescued by the "token=" label
    expect(text).not.toContain(GHP_TOKEN.slice(0, 20));
  });

  it('the SAME truncated fragment with no adjacent label is still rescued by the ' +
     'entropy fallback — AS LONG AS the fragment itself is >= the 20-char token floor', () => {
    // Same 20-char fragment, but embedded in prose rather than after "token=" —
    // no vendor match (too short), no label, but entropy alone is enough here.
    const fragment = GHP_TOKEN.slice(0, 20);
    const partial = `I found this in the config: ${fragment} and I think`;
    const { text, events } = redactText(partial);
    expect(events.some(e => e.type === 'high_entropy')).toBe(true);
    expect(text).not.toContain(fragment);
  });

  it('GAP: a SHORTER truncation of the exact same fragment (<20 chars, e.g. a very ' +
     'early mid-stream read) falls below the entropy detector\'s MIN_TOKEN_LENGTH floor ' +
     '(src/redact/entropy.ts) and is not redacted by anything — the real cutoff for ' +
     'truncated-secret coverage is that floor, not a specific vendor pattern', () => {
    const shortFragment = GHP_TOKEN.slice(0, 17); // "ghp_" + 13 chars = 17 total
    const partial = `I found this in the config: ${shortFragment} and I think`;
    const { text, events } = redactText(partial);
    expect(events.length).toBe(0);
    expect(text).toBe(partial);
  });

  it('a full secret arriving intact within a short partial turn IS still redacted', () => {
    // The turn is "partial" in the sense that it's a fragment of a larger
    // response, but the secret itself landed complete inside it — the common
    // case for short high-frequency turns.
    const partial = `...and here's the key: ${AWS_KEY}`;
    const { text, events } = redactText(partial);
    expect(text).not.toContain(AWS_KEY);
    expect(events.some(e => e.type === 'aws_access_key')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Env-dump / connection-string shapes pasted into a turn — the ADR-012
//    dispatch brief specifically calls out "env dumps" and "connection
//    strings" as auto-capture-relevant shapes (a user pasting `.env` content
//    or a DB URL into a mid-conversation turn, now captured at higher
//    frequency than only-at-session-end).
// ---------------------------------------------------------------------------

describe('auto-capture shape — multi-line env dump in a single turn', () => {
  it('redacts every labeled credential line in a pasted .env-style dump', () => {
    const envDump = [
      'NODE_ENV=production',
      'PORT=7777',
      `GITHUB_TOKEN=${GHP_TOKEN}`,
      'DATABASE_URL=postgres://svcuser:sup3rs3cr3t@db.internal:5432/app',
      'LOG_LEVEL=info',
    ].join('\n');
    const { text, events } = redactText(envDump);
    expect(text).toContain('NODE_ENV=production'); // non-secret lines untouched
    expect(text).toContain('PORT=7777');
    expect(text).toContain('LOG_LEVEL=info');
    expect(text).not.toContain(GHP_TOKEN);
    expect(text).not.toContain('svcuser:sup3rs3cr3t');
    const types = events.map(e => e.type);
    expect(types).toContain('github_token');
    expect(types).toContain('connection_string');
  });

  it('a SCREAMING_SNAKE_CASE env-var name compounded onto "key/token/secret" (e.g. ' +
     'OPENAI_API_KEY=) is NOT caught by the labeled generic_credential detector — \\b ' +
     'does not match between two word characters ("I" and "_") — but a sufficiently ' +
     'random value in that shape is still rescued by the entropy fallback', () => {
    const line = 'OPENAI_API_KEY=sk-proj-9f8e7d6c5b4a3210';
    const { text, events } = redactText(line);
    const genericHit = events.some(e => e.type === 'generic_credential');
    expect(genericHit).toBe(false); // confirms the \b/underscore label gap exists today
    // The whole label+value token (no whitespace around "=") is tokenized as
    // one unit by the entropy detector; its randomness clears the 4.0
    // bits/char default threshold, so THIS value is rescued — but that is a
    // property of this specific value's randomness, not a general guarantee.
    expect(events.some(e => e.type === 'high_entropy')).toBe(true);
    expect(text).not.toContain('sk-proj-9f8e7d6c5b4a3210');
  });

  it('GAP: "INTERNAL_SECRET=<value>" is not rescued by anything — the labeled ' +
     'detector misses it for the same \\b/underscore reason, AND this particular ' +
     'label+value combination sits just under the 4.0 bits/char entropy threshold ' +
     '(measured 3.97) — confirmed by direct measurement, not assumed', () => {
    const line = 'INTERNAL_SECRET=abc123';
    const { text, events } = redactText(line);
    expect(events.length).toBe(0);
    expect(text).toBe(line);
  });

  it('for contrast: DB_PASSWORD=<value> and SERVICE_PWD=<value> in the SAME ' +
     'SCREAMING_SNAKE_CASE shape ARE rescued by entropy — confirms the residual gap ' +
     'is value/label-combination-dependent, not a blanket miss on this whole shape', () => {
    for (const line of ['DB_PASSWORD=letmein123456', 'SERVICE_PWD=abc123456']) {
      const { text, events } = redactText(line);
      expect(events.some(e => e.type === 'high_entropy')).toBe(true);
      expect(text).not.toBe(line);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Structural noise auto-capture adds — markdown code fences, since a
//    higher-frequency capture is more likely to grab an in-progress code
//    block than a finished, well-formed transcript turn.
// ---------------------------------------------------------------------------

describe('auto-capture shape — secret inside a markdown code fence', () => {
  it('entropy detector still fires on a high-entropy blob inside a code fence', () => {
    const blob = 'zT9kQ2vXmN4pR8wL1sYbF6cH3jD0eAgi'; // same fixture as the base suite, entropy 5.0
    const turn = '```bash\nexport SESSION_SECRET=' + blob + '\n```';
    const { text, events } = redactText(turn);
    expect(text).not.toContain(blob);
    expect(events.length).toBeGreaterThan(0);
  });
});
