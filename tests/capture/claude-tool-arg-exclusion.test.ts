/**
 * FEAT-455 spike (ADR-012 decisions 1 + 5): proves, by test rather than
 * assertion, that hook-tap capture (`parseClaudeTranscript` /
 * `src/capture/claude.ts`) structurally cannot leak tool_use/tool_result
 * block content — the broader disclosure surface ADR-012 explicitly reserves
 * for the deferred Tier 2 MCP-tap ("tool call args/results ... file
 * contents, DB rows, and third-party credentials can appear in tool args",
 * ADR-012 decision 1).
 *
 * `extractText()` (src/capture/claude.ts:64-79) only pulls `type: 'text'`
 * content blocks out of a message; `tool_use`/`tool_result` blocks are
 * dropped entirely before the envelope is even built — this is not a
 * redaction question (stage-0 never runs on data it never receives). The
 * existing FEAT-449 suite (tests/capture/claude.test.ts) already asserts
 * this in passing for one non-secret tool_use fixture; this file makes it
 * the explicit subject with secret-shaped payloads in both tool_use.input
 * and tool_result.content, backing ADR-012's "hook-tap is a materially
 * narrower disclosure surface than MCP-tap" claim with evidence rather than
 * only the module doc comment's assertion.
 */

import { describe, it, expect } from 'vitest';
import { parseClaudeTranscript } from '../../src/capture/claude.js';

const line = (obj: unknown): string => JSON.stringify(obj);

const AWS_KEY = 'AKIAHSDOZALWHS3EPALW';
const DB_ROW_SECRET = { ssn: '078-05-1120', card: '4111111111111111' };

describe('parseClaudeTranscript — tool_use/tool_result args are excluded by construction', () => {
  it('a secret embedded in a tool_use.input never reaches the parsed turns text', () => {
    const session = [
      line({ type: 'user', sessionId: 's1', message: { role: 'user', content: 'set AWS_KEY in the .env file' } }),
      line({
        type: 'assistant',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'x1', name: 'Edit', input: { file: '.env', content: `AWS_KEY=${AWS_KEY}` } },
          ],
        },
      }),
    ].join('\n');

    const parsed = parseClaudeTranscript(session, '/x/s1.jsonl');
    const allText = parsed.turns.map(t => t.text).join('\n');
    expect(allText).not.toContain(AWS_KEY);
    // Only the user turn survives — the assistant turn here has no text
    // block at all (tool_use only), so it contributes nothing.
    expect(parsed.turns).toEqual([{ role: 'user', text: 'set AWS_KEY in the .env file' }]);
  });

  it('a DB row (file contents / query result shape) embedded in a tool_result.content ' +
     'never reaches the parsed turns text either', () => {
    const session = [
      line({ type: 'user', sessionId: 's2', message: { role: 'user', content: 'look up that customer record' } }),
      line({
        type: 'assistant',
        sessionId: 's2',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'x2',
              content: [{ type: 'text', text: JSON.stringify(DB_ROW_SECRET) }],
            },
          ],
        },
      }),
    ].join('\n');

    const parsed = parseClaudeTranscript(session, '/x/s2.jsonl');
    const allText = parsed.turns.map(t => t.text).join('\n');
    expect(allText).not.toContain(DB_ROW_SECRET.ssn);
    expect(allText).not.toContain(DB_ROW_SECRET.card);
    // extractText() only recognizes a top-level `type: 'text'` block on the
    // MESSAGE's own content array — a nested `content` array one level down
    // inside a tool_result block (this fixture's shape) is not walked at
    // all, which is exactly the narrower-surface property this test exists
    // to demonstrate: hook-tap has no code path that reaches into tool
    // args/results, not even accidentally via a shape coincidence.
    expect(parsed.turns).toEqual([{ role: 'user', text: 'look up that customer record' }]);
  });

  it('a mixed turn (real assistant text ALONGSIDE a tool_use with a secret in its ' +
     'input) keeps the text and drops the tool_use — partial exclusion within one turn', () => {
    const session = [
      line({
        type: 'assistant',
        sessionId: 's3',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Updating the deploy script now.' },
            { type: 'tool_use', id: 'x3', name: 'Bash', input: { command: `export TOKEN=${AWS_KEY}` } },
          ],
        },
      }),
    ].join('\n');

    const parsed = parseClaudeTranscript(session, '/x/s3.jsonl');
    expect(parsed.turns).toEqual([{ role: 'assistant', text: 'Updating the deploy script now.' }]);
    expect(parsed.turns.map(t => t.text).join('\n')).not.toContain(AWS_KEY);
  });
});
