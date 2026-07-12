/**
 * Stage-0 secret redaction tests (SEC-3..6/SEC-9, AC-3 + redaction parts of
 * AC-5/AC-6). See docs/specs/2026-07-02-encryption-and-secret-redaction.md.
 */

import { describe, it, expect } from 'vitest';
import { redactText, redactIfEnabled, type RedactionEvent } from '../../src/redact/index.js';
import { defaultConfig } from '../../src/config/config.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { makeMockProviders } from '../../src/pipeline/mock-providers.js';
import type { DB } from '../../src/storage/db.js';

// ---------------------------------------------------------------------------
// True-positive detector fixtures (>=25 rows spanning every detector type)
// ---------------------------------------------------------------------------

interface TruePositiveCase {
  name: string;
  input: string;
  type: string;
  /** Raw secret substring that must NOT survive in the output. */
  secret: string;
  /**
   * Total number of redaction events the input must produce — defaults to
   * 1. FEAT-463 validation fix: a spurious extra match (e.g. the `=>`
   * arrow-backtracking bug, detectors.ts `QUOTED_LABEL_SEP`) can leave the
   * expected secret redacted and hide from a placeholder-presence-only
   * check while still corrupting output and inflating the redaction log —
   * asserting the exact count catches that class where presence checks
   * don't.
   */
  expectedEventCount?: number;
}

const AWS_KEY = 'AKIAHSDOZALWHS3EPALW';
const GHP_TOKEN = 'ghp_HKNQTWZcfilorux0369CFILORUXadgjmpsvy';
const GHO_TOKEN = 'gho_HKNQTWZcfilorux0369CFILORUXadgjmpsvy';
const GHU_TOKEN = 'ghu_HKNQTWZcfilorux0369CFILORUXadgjmpsvy';
const GHS_TOKEN = 'ghs_HKNQTWZcfilorux0369CFILORUXadgjmpsvy';
const GITHUB_PAT = 'github_pat_HMRWbglqv05AFKPUZejoty38DINSXchmrw16BGLQVafkpuz49EJOTYdinsx2';
const GCP_KEY = 'AIzaSyD9tSrke72PouQMnMXa7eZSW0jkFMBcXYZ';
const SLACK_TOKEN = 'xoxb-hjlnprtvxzbdfhjlnprtvxz13579bd';
const AZURE_BARE_KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/ABCDEFGHIJKLMNOPQRSTUV==';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const PEM_BLOCK =
  '-----BEGIN RSA PRIVATE KEY-----\n' +
  'MIIEowIBAAKCAQEAx8y2f3z9q8v7u6t5s4r3q2p1o0n9m8l7k6j5i4h3g2f1e0d\n' +
  '-----END RSA PRIVATE KEY-----';
const HIGH_ENTROPY_BLOB = 'zT9kQ2vXmN4pR8wL1sYbF6cH3jD0eAgi'; // 32 unique chars, entropy 5.0

const TRUE_POSITIVES: TruePositiveCase[] = [
  { name: 'AWS access key', input: `key is ${AWS_KEY} in the env`, type: 'aws_access_key', secret: AWS_KEY },
  { name: 'GitHub token ghp_', input: `token ${GHP_TOKEN} leaked`, type: 'github_token', secret: GHP_TOKEN },
  { name: 'GitHub token gho_', input: `oauth ${GHO_TOKEN} leaked`, type: 'github_token', secret: GHO_TOKEN },
  { name: 'GitHub token ghu_', input: `user-to-server ${GHU_TOKEN} leaked`, type: 'github_token', secret: GHU_TOKEN },
  { name: 'GitHub token ghs_', input: `server-to-server ${GHS_TOKEN} leaked`, type: 'github_token', secret: GHS_TOKEN },
  { name: 'GitHub fine-grained PAT', input: `pat ${GITHUB_PAT} in ci log`, type: 'github_token', secret: GITHUB_PAT },
  {
    name: 'Azure AccountKey= in connection string',
    input: 'DefaultEndpointsProtocol=https;AccountKey=abcd1234EFGH5678ijkl9012MNOP3456==;EndpointSuffix=core.windows.net',
    type: 'azure_key',
    secret: 'abcd1234EFGH5678ijkl9012MNOP3456==',
  },
  {
    name: 'Azure SAS sig= query param',
    input: 'https://foo.blob.core.windows.net/x?sv=2020-08-04&sig=abcd1234%2Fefgh%3D9012xyzuvw',
    type: 'azure_key',
    secret: 'abcd1234%2Fefgh%3D9012xyzuvw',
  },
  { name: 'Azure bare 88-char base64 key', input: `key: ${AZURE_BARE_KEY} rotate soon`, type: 'azure_key', secret: AZURE_BARE_KEY },
  { name: 'GCP API key', input: `client uses ${GCP_KEY} for maps`, type: 'gcp_api_key', secret: GCP_KEY },
  { name: 'Slack bot token', input: `webhook ${SLACK_TOKEN} configured`, type: 'slack_token', secret: SLACK_TOKEN },
  { name: 'generic password=', input: 'password=hunter2', type: 'generic_credential', secret: 'hunter2' },
  { name: 'generic Password= (AC-3 case)', input: 'Password=hunter2;', type: 'generic_credential', secret: 'hunter2;' },
  { name: 'generic api_key:', input: 'api_key: sk_live_abcdxyz123', type: 'generic_credential', secret: 'sk_live_abcdxyz123' },
  { name: 'generic api-key=', input: 'api-key=zzzz9999yyyy8888', type: 'generic_credential', secret: 'zzzz9999yyyy8888' },
  { name: 'generic secret=', input: 'secret=topsecretvalue123', type: 'generic_credential', secret: 'topsecretvalue123' },
  { name: 'generic token=', input: 'token=abcdef123456', type: 'generic_credential', secret: 'abcdef123456' },
  { name: 'generic passwd=', input: 'passwd=letmein123456', type: 'generic_credential', secret: 'letmein123456' },
  { name: 'generic pwd=', input: 'pwd=qwerty123456789', type: 'generic_credential', secret: 'qwerty123456789' },
  { name: 'generic PASSWORD= (case-insensitive)', input: 'PASSWORD=SuperSecret123', type: 'generic_credential', secret: 'SuperSecret123' },
  { name: 'JWT', input: `Authorization: Bearer ${JWT}`, type: 'jwt', secret: JWT },
  { name: 'PEM private key block', input: `dumping key\n${PEM_BLOCK}\ndone`, type: 'pem_private_key', secret: PEM_BLOCK },
  {
    name: 'postgres connection string userinfo',
    input: 'DATABASE_URL=postgres://myuser:mypassword@localhost:5432/mydb',
    type: 'connection_string',
    secret: 'myuser:mypassword',
  },
  {
    name: 'mysql connection string userinfo',
    input: 'conn: mysql://admin:s3cr3tpw@db.internal:3306/app',
    type: 'connection_string',
    secret: 'admin:s3cr3tpw',
  },
  { name: 'high-entropy unlabeled blob', input: `random blob ${HIGH_ENTROPY_BLOB} embedded here`, type: 'high_entropy', secret: HIGH_ENTROPY_BLOB },
  // FEAT-463 review fix (CRITICAL bypass, closed): the entropy-guard's
  // earlier keyword-substring check suppressed these entirely — a
  // high-entropy secret that happens to (a) be built only from letters/
  // digits/underscores, (b) contain a recognized keyword substring
  // anywhere in its own characters, and (c) end in a bare `:`/`=` glued
  // directly on with no separator in the middle — is NOT a value-less
  // label and must still be redacted as `high_entropy`.
  {
    name: 'entropy bypass repro: keyword-in-value + trailing "=" (base64-padding shape)',
    input: 'mysecrettoken1234567890abcdef=',
    type: 'high_entropy',
    secret: 'mysecrettoken1234567890abcdef=',
  },
  {
    name: 'entropy bypass repro: keyword-in-value + trailing ":" variant',
    input: 'mysecrettoken1234567890abcdef:',
    type: 'high_entropy',
    secret: 'mysecrettoken1234567890abcdef:',
  },
  {
    name: 'entropy bypass repro: keyword as a clean underscore-delimited segment (does not close the gap either)',
    input: 'my_secret_token_9f8a7b6c5d4e3f2a1b0c=',
    type: 'high_entropy',
    secret: 'my_secret_token_9f8a7b6c5d4e3f2a1b0c=',
  },
  {
    name: 'entropy bypass control: identical shape, no keyword substring — always redacted (proves the keyword check was the hole, not the shape)',
    input: 'myrandomvalue1234567890abcdef=',
    type: 'high_entropy',
    secret: 'myrandomvalue1234567890abcdef=',
  },
  // FEAT-463 review fix round 2 (CRITICAL suffix-attack bypass, closed): round
  // 1's "safe value immediately follows" check trusted next-token SHAPE alone
  // — appending a plausible decoy (a bare digit, boolean, or quoted digit/
  // boolean) right after one of the round-1 repro tokens revived the exact
  // same leak by making the secret masquerade as a label with its value on
  // the next token. The round-2 fix requires the label's own identifier core
  // (quotes/separator stripped) to itself be low-entropy — a genuine secret
  // hiding behind this shape fails that check regardless of what follows it.
  {
    name: 'suffix-attack repro: secret + trailing "=" + bare digit decoy',
    input: 'mysecrettoken1234567890abcdef= 8',
    type: 'high_entropy',
    secret: 'mysecrettoken1234567890abcdef=',
  },
  {
    name: 'suffix-attack repro: secret + trailing "=" + bare boolean decoy',
    input: 'mysecrettoken1234567890abcdef= true',
    type: 'high_entropy',
    secret: 'mysecrettoken1234567890abcdef=',
  },
  {
    name: 'suffix-attack repro: secret + trailing ":" + bare digit decoy',
    input: 'mysecrettoken1234567890abcdef: 8',
    type: 'high_entropy',
    secret: 'mysecrettoken1234567890abcdef:',
  },
  {
    name: 'suffix-attack repro: underscore-segment variant + digit decoy',
    input: 'my_secret_token_9f8a7b6c5d4e3f2a1b0c= 42',
    type: 'high_entropy',
    secret: 'my_secret_token_9f8a7b6c5d4e3f2a1b0c=',
  },
  {
    name: 'suffix-attack repro: secret + trailing "=" + quoted-digit decoy',
    input: 'mysecrettoken1234567890abcdef= "8"',
    type: 'high_entropy',
    secret: 'mysecrettoken1234567890abcdef=',
  },
  {
    name: 'suffix-attack repro: secret + trailing "=" + quoted-boolean decoy',
    input: 'mysecrettoken1234567890abcdef= "true"',
    type: 'high_entropy',
    secret: 'mysecrettoken1234567890abcdef=',
  },
  {
    name: 'multi-token line: legit label:value pair stays unredacted, unrelated trailing secret (nothing following it) still redacts',
    input: 'PASSWORD_MIN_LENGTH: 8 mysecrettoken1234567890abcdef=',
    type: 'high_entropy',
    secret: 'mysecrettoken1234567890abcdef=',
  },
  // FEAT-459: compound SCREAMING_SNAKE_CASE labels (`X_SECRET=`, `X_API_KEY=`,
  // `X_TOKEN=`), both '=' and ':' separators, plus the exact measured gap fixture.
  { name: 'compound INTERNAL_SECRET= (measured gap fixture)', input: 'INTERNAL_SECRET=abc123', type: 'generic_credential', secret: 'abc123' },
  { name: 'compound OPENAI_API_KEY=', input: 'OPENAI_API_KEY=sk-proj-9f8e7d6c5b4a3210', type: 'generic_credential', secret: 'sk-proj-9f8e7d6c5b4a3210' },
  { name: 'compound X_TOKEN: with colon separator', input: 'SESSION_TOKEN: abcdefghijk123', type: 'generic_credential', secret: 'abcdefghijk123' },
  { name: 'compound DB_PASSWORD=', input: 'DB_PASSWORD=letmein123456', type: 'generic_credential', secret: 'letmein123456' },
  { name: 'labeled short fragment (<20 chars, no entropy floor applies)', input: `token=${GHP_TOKEN.slice(0, 17)}`, type: 'generic_credential', secret: GHP_TOKEN.slice(0, 17) },
  // FEAT-459 review fix: high-precision keywords (secret/password/passwd/pwd)
  // matched as ANY underscore-delimited segment, not just trailing — these
  // are the 5 reviewer-confirmed misses (SECRET_KEY is arguably the single
  // most common secret label in existence: Django settings.py, Flask
  // app.secret_key, Rails secret_key_base).
  { name: 'SECRET_KEY= (leading segment)', input: 'SECRET_KEY=abcdefgh1234', type: 'generic_credential', secret: 'abcdefgh1234' },
  { name: 'DJANGO_SECRET_KEY= (middle segment)', input: 'DJANGO_SECRET_KEY=abcdefgh1234', type: 'generic_credential', secret: 'abcdefgh1234' },
  { name: 'JWT_SECRET_KEY= (middle segment)', input: 'JWT_SECRET_KEY=abcdefgh1234', type: 'generic_credential', secret: 'abcdefgh1234' },
  { name: 'APP_SECRET_KEY= (middle segment)', input: 'APP_SECRET_KEY=abcdefgh1234', type: 'generic_credential', secret: 'abcdefgh1234' },
  { name: 'secret_key_base: (Rails convention, colon separator)', input: 'secret_key_base: abcdefgh1234', type: 'generic_credential', secret: 'abcdefgh1234' },
  // FEAT-463: quoted/JSON label forms — separator no longer needs to
  // immediately follow the keyword; a closing quote/apostrophe (label side)
  // and a quoted OR bare value are both tolerated. New detector type
  // (`generic_credential_quoted`) keeps these observable as a distinct shape
  // from the plain trailing-unquoted match (AC-5).
  {
    name: 'AC-1a: JSON double-quoted label + double-quoted value (trailing keyword api_key)',
    input: '"OPENAI_API_KEY": "sk-proj-AbCdEf1234567890"',
    type: 'generic_credential_quoted',
    secret: 'sk-proj-AbCdEf1234567890',
  },
  {
    name: 'AC-1b: JSON double-quoted label + double-quoted value (compound keyword secret, middle segment)',
    input: '"DJANGO_SECRET_KEY": "abcdefgh1234"',
    type: 'generic_credential_quoted',
    secret: 'abcdefgh1234',
  },
  {
    name: 'AC-1c: quoted label + bare value, no space around separator (compound keyword secret, leading segment)',
    input: '"SECRET_KEY"=abcdefgh1234',
    type: 'generic_credential_quoted',
    secret: 'abcdefgh1234',
  },
  {
    name: 'AC-2: PHP array-arrow form, single-quoted label + single-quoted value (trailing keyword password)',
    input: "'DB_PASSWORD' => 'hunter2'",
    type: 'generic_credential_quoted',
    secret: 'hunter2',
    expectedEventCount: 1,
  },
  {
    name: 'quoted label (single quote) + bare value, trailing keyword token',
    input: "'SESSION_TOKEN'=abcdefghijk123",
    type: 'generic_credential_quoted',
    secret: 'abcdefghijk123',
  },
  {
    name: 'quoted label (double quote) + single-quoted value, compound keyword password',
    input: '"APP_PASSWORD_HASH": \'zzzz9999yyyy8888\'',
    type: 'generic_credential_quoted',
    secret: 'zzzz9999yyyy8888',
  },
  // FEAT-463 validation fix (MEDIUM, live-reproduced): `=>` arrow-shape
  // sweep across all 6 quoted-family entries. Each of these previously
  // risked a spurious second match from a *sibling* entry backtracking the
  // `(?:=>|[:=])` separator down to a bare `=`, leaving `>` unconsumed and
  // captured as a bogus 1-char "secret" by the bare-value entry (root
  // cause: detectors.ts `QUOTED_LABEL_SEP`). `expectedEventCount: 1`
  // (explicit here, though it's the default) is the whole point of these
  // fixtures — the secret being redacted was never in question; the bug
  // hid from a placeholder-presence-only check.
  {
    name: 'arrow sweep: validator\'s exact live-repro string (single-quoted label + single-quoted value)',
    input: "'DB_PASSWORD' => 'hunter2xx'",
    type: 'generic_credential_quoted',
    secret: 'hunter2xx',
    expectedEventCount: 1,
  },
  {
    name: 'arrow sweep: trailing family, double-quoted label + double-quoted value',
    input: '"DB_PASSWORD" => "hunter2xx"',
    type: 'generic_credential_quoted',
    secret: 'hunter2xx',
    expectedEventCount: 1,
  },
  {
    name: 'arrow sweep: trailing family, single-quoted label + bare value',
    input: "'DB_PASSWORD' => hunter2xxbare",
    type: 'generic_credential_quoted',
    secret: 'hunter2xxbare',
    expectedEventCount: 1,
  },
  {
    name: 'arrow sweep: compound family, double-quoted label + double-quoted value',
    input: '"DJANGO_SECRET_KEY" => "abcdefgh1234"',
    type: 'generic_credential_quoted',
    secret: 'abcdefgh1234',
    expectedEventCount: 1,
  },
  {
    name: 'arrow sweep: compound family, single-quoted label + single-quoted value',
    input: "'DJANGO_SECRET_KEY' => 'abcdefgh1234'",
    type: 'generic_credential_quoted',
    secret: 'abcdefgh1234',
    expectedEventCount: 1,
  },
  {
    name: 'arrow sweep: compound family, single-quoted label + bare value',
    input: "'SECRET_KEY' => abcdefgh1234bare",
    type: 'generic_credential_quoted',
    secret: 'abcdefgh1234bare',
    expectedEventCount: 1,
  },
  // FEAT-473 (FEAT-463 review LOW finding #2): Unicode "smart"/curly quotes
  // ("“”" double, "‘’" single) around a credential label
  // were entirely unrecognized before this FEAT — a smart-quoted JSON/PHP
  // payload fell through to the entropy stage, and a SHORT secret (under
  // the 20-char entropy floor) leaked in full (long secrets were always
  // caught by entropy regardless of quote style). Every secret below is
  // deliberately short to prove the total-leak class specifically, not just
  // "some redaction happened."
  {
    name: 'FEAT-473: curly double quotes both sides, trailing keyword (SHORT secret, under the entropy floor)',
    input: '“API_KEY”: “short1”',
    type: 'generic_credential_quoted',
    secret: 'short1',
    expectedEventCount: 1,
  },
  {
    name: 'FEAT-473: curly single quotes both sides, PHP-arrow form, trailing keyword (SHORT secret)',
    input: '‘DB_PASSWORD’ => ‘short2’',
    type: 'generic_credential_quoted',
    secret: 'short2',
    expectedEventCount: 1,
  },
  {
    name: 'FEAT-473: mixed double quotes — curly-open, straight-close value (word-processor mangle touching only one side)',
    input: '"API_KEY": “short3"',
    type: 'generic_credential_quoted',
    secret: 'short3',
    expectedEventCount: 1,
  },
  {
    name: 'FEAT-473: mixed double quotes — straight-open, curly-close value (mangle in the other direction)',
    input: '"API_KEY": "short4”',
    type: 'generic_credential_quoted',
    secret: 'short4',
    expectedEventCount: 1,
  },
  {
    name: 'FEAT-473: mixed single quotes — curly-open, straight-close value',
    input: "'DB_PASSWORD' => ‘short5'",
    type: 'generic_credential_quoted',
    secret: 'short5',
    expectedEventCount: 1,
  },
  {
    name: 'FEAT-473: mixed single quotes — straight-open, curly-close value',
    input: "'DB_PASSWORD' => 'short6’",
    type: 'generic_credential_quoted',
    secret: 'short6',
    expectedEventCount: 1,
  },
  {
    name: 'FEAT-473: curly double quotes, compound keyword (middle segment), SHORT secret',
    input: '“DJANGO_SECRET_KEY”: “short7”',
    type: 'generic_credential_quoted',
    secret: 'short7',
    expectedEventCount: 1,
  },
  {
    name: 'FEAT-473: curly-closed label + bare (unquoted) value, trailing keyword',
    input: '“SESSION_TOKEN”=short8bareval',
    type: 'generic_credential_quoted',
    secret: 'short8bareval',
    expectedEventCount: 1,
  },
  {
    name: 'FEAT-473: curly single quotes, compound keyword (leading segment), SHORT secret',
    input: '‘SECRET_KEY’: ‘short9’',
    type: 'generic_credential_quoted',
    secret: 'short9',
    expectedEventCount: 1,
  },
  // FEAT-468: numeric-secret digit-run heuristic. Shannon entropy over a
  // 10-symbol (digits-only) alphabet caps at log2(10) ≈ 3.32 bits/char, below
  // the 4.0 default threshold, so an unlabeled all-digit secret was
  // structurally invisible regardless of length — see entropy.ts
  // `findNumericSecretRuns`. These fixtures are the exact FEAT-463
  // final-review repro plus the FEAT's stated true-positive range; the
  // false-positive corpus proving this doesn't overtrigger on phone
  // numbers/timestamps/IDs/labeled values lives in the dedicated describe
  // block below (those all stay UNredacted).
  //
  // FEAT-468 review round 1 (MEDIUM fix): the minimum floor moved 20 -> 23
  // to dodge real unlabeled 20/22-digit USPS tracking-number shapes (see the
  // FP corpus below) — the boundary fixtures here reflect the NEW floor.
  {
    name: 'FEAT-468: FEAT-463 final-review repro — bare unlabeled 26-digit string (entropy 3.295, previously leaked)',
    input: 'account number 98765432109876543210987654 on file',
    type: 'numeric_secret',
    secret: '98765432109876543210987654',
  },
  {
    name: 'FEAT-468: unlabeled 23-digit token (exact minimum-floor boundary post-review-fix — must redact)',
    input: 'ref 12345678901234567890123 confirmed',
    type: 'numeric_secret',
    secret: '12345678901234567890123',
  },
  {
    name: 'FEAT-468: unlabeled 32-digit token (upper end of stated true-positive range)',
    input: 'legacy id 12345678901234567890123456789012 archived',
    type: 'numeric_secret',
    secret: '12345678901234567890123456789012',
  },
  {
    name: 'FEAT-468: digit-heavy legacy token glued to a non-keyword alpha prefix (only the digit run is redacted, not the prefix)',
    input: 'ACCT98765432109876543210987 rotate',
    type: 'numeric_secret',
    secret: '98765432109876543210987',
  },
  // FEAT-468 review round 1 (HIGH fix, counter-case): a genuinely
  // SECRET-labeled numeric value must still be redacted — just by the
  // upstream stage-2 pattern detector (generic_credential), not by the
  // stage-3 numeric-secret heuristic this fix round scoped label-awareness
  // into. Pins WHICH stage catches it so a future change can't silently
  // drop coverage without a test noticing.
  {
    name: 'FEAT-468 review round 1 counter-case: TOKEN=<26 digits> is still redacted, by generic_credential (stage 2), not numeric_secret (stage 3)',
    input: 'TOKEN=98765432109876543210987654',
    type: 'generic_credential',
    secret: '98765432109876543210987654',
  },
  // FEAT-468 review round 2 (MEDIUM fix, HITL decision: label guard is
  // SAME-LINE ONLY): a transcript-header shape (`Summary:`/`Result:` on its
  // own line, secret on the next) is NOT a real label on the value that
  // follows it — it's routine LLM output formatting, and the value must
  // still redact. This is the exact false-negative class round 1's
  // cross-line-capable window let slip through.
  {
    name: 'FEAT-468 review round 2: "Summary:\\n<secret>" still redacts — a previous-line header is not a same-line label',
    input: 'Summary:\n11223344556677889900112233',
    type: 'numeric_secret',
    secret: '11223344556677889900112233',
  },
  {
    name: 'FEAT-468 review round 2: "Result:\\n<secret>" still redacts — a previous-line header is not a same-line label',
    input: 'Result:\n99887766554433221100998877',
    type: 'numeric_secret',
    secret: '99887766554433221100998877',
  },
];

describe('redactText — true positives (table-driven)', () => {
  it.each(TRUE_POSITIVES)('$name -> type $type', ({ input, type, secret, expectedEventCount }) => {
    const { text, events } = redactText(input);
    expect(text).not.toContain(secret);
    expect(events.some(e => e.type === type)).toBe(true);
    expect(text).toMatch(new RegExp(`\\[REDACTED:${type}:[0-9a-f]{8}\\]`));
    // FEAT-463 validation fix: exact event count, not just placeholder
    // presence — a spurious extra match hides from the checks above.
    expect(events.length).toBe(expectedEventCount ?? 1);
  });

  it('covers at least 25 true-positive fixtures', () => {
    expect(TRUE_POSITIVES.length).toBeGreaterThanOrEqual(25);
  });
});

// ---------------------------------------------------------------------------
// FEAT-463 validation fix: PHP `=>` arrow output integrity (MEDIUM,
// live-reproduced by the validator — see detectors.ts QUOTED_LABEL_SEP).
// The it.each count assertion above catches the spurious-event symptom;
// these assert the specific, previously-corrupted output byte-for-byte.
// ---------------------------------------------------------------------------

describe('redactText — PHP array-arrow (=>) output integrity', () => {
  it('exactly one event and the `=>` arrow survives byte-intact (validator\'s live repro)', () => {
    const { text, events } = redactText("'DB_PASSWORD' => 'hunter2xx'");
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe('generic_credential_quoted');
    expect(text).not.toContain('hunter2xx');
    expect(text).toContain("'DB_PASSWORD' => '");
    expect(text).not.toContain('=[REDACTED:'); // the corrupted-arrow shape from the bug
    expect(text).toMatch(/^'DB_PASSWORD' => '\[REDACTED:generic_credential_quoted:[0-9a-f]{8}\]'$/);
  });

  it('arrow with an unquoted (bare) value also stays byte-intact', () => {
    const { text, events } = redactText("'DB_PASSWORD' => hunter2xxbare");
    expect(events.length).toBe(1);
    expect(text).toContain("'DB_PASSWORD' => ");
    expect(text).not.toContain('=[REDACTED:');
  });
});

// custom pattern from config — separate case since it needs opts.
describe('redactText — custom pattern (config-supplied)', () => {
  it('redacts a match of a custom regex with type "custom"', () => {
    const { text, events } = redactText('ticket FOO-123456 opened', {
      customPatterns: ['FOO-\\d{6}'],
    });
    expect(text).not.toContain('FOO-123456');
    expect(events.some(e => e.type === 'custom')).toBe(true);
  });

  it('does not throw on an invalid custom regex — skips it', () => {
    expect(() => redactText('hello world', { customPatterns: ['('] })).not.toThrow();
  });

  // FEAT-461 review fix (Finding 1, HIGH): a config.yaml written by a newer
  // daemon and later read by an OLDER `loadConfigFromDisk` (no flow-sequence
  // array support — a `reinstall --rollback` target) would parse
  // `customPatterns: [...]` back as the literal string "[...]", not an
  // array. `??  []` alone doesn't catch a truthy non-array value reaching
  // `.map()`; `Array.isArray` must be checked explicitly.
  it('treats a non-array customPatterns (e.g. a stringified "[]" from an older loader) as no custom patterns, not a crash', () => {
    expect(() => redactText('hello world', { customPatterns: '[]' as unknown as string[] })).not.toThrow();
    const { events } = redactText('hello world', { customPatterns: '[]' as unknown as string[] });
    expect(events.some(e => e.type === 'custom')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// False-positive guards
// ---------------------------------------------------------------------------

describe('redactText — false-positive guards', () => {
  it('does not redact a 64-char balanced hex string next to the word "commit"', () => {
    const hash = '62aeb7f056495d28df3f43f50cb2bd1871637a0653419712accd49e908a8bece'; // entropy exactly 4.0
    const input = `latest commit ${hash} is green`;
    const { text, events } = redactText(input);
    expect(text).toContain(hash);
    expect(events.length).toBe(0);
  });

  it('does not redact a UUID', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const input = `request id ${uuid} logged`;
    const { text, events } = redactText(input);
    expect(text).toContain(uuid);
    expect(events.length).toBe(0);
  });

  it('does not redact a Windows file path', () => {
    const path = 'C:\\Users\\milas\\AppData\\Local\\Temp\\claude\\workspace\\file.txt';
    const input = `opening ${path} now`;
    const { text, events } = redactText(input);
    expect(text).toContain(path);
    expect(events.length).toBe(0);
  });

  it('does not redact a long English word/sentence', () => {
    const input = 'the word supercalifragilisticexpialidocious appears in a famous song';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a short base64 image fragment near "sha256 digest"', () => {
    const input = 'sha256 digest: iVBORw0KGgo (thumbnail)';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  // FEAT-459: the compound-label lookbehind fix widens what generic_credential
  // matches — these are the riskiest shapes it could newly overtrigger on
  // (env-var assignments that are common, non-secret, and superficially close
  // to a compound label), so each gets an explicit negative fixture.
  it('does not redact NODE_ENV=production', () => {
    const input = 'NODE_ENV=production';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact LOG_LEVEL=debug', () => {
    const input = 'LOG_LEVEL=debug';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact PORT=7777', () => {
    const input = 'PORT=7777';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact MAX_TOKENS=100 (plural "TOKENS", not the "token" keyword)', () => {
    const input = 'MAX_TOKENS=100';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact primary_key=id (bare "_key" compound was never a recognized label)', () => {
    const input = 'primary_key=id';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a plain code assignment "result = value"', () => {
    const input = 'result = value';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  // FEAT-459 review fix: the any-segment detector for secret/password/passwd/
  // pwd is lower-precision than a trailing match, so a middle-segment keyword
  // describing a CONFIG KNOB about a secret (not the secret itself) must not
  // redact a plain numeric or boolean value.
  it('does not redact PASSWORD_MIN_LENGTH=8 (numeric value, middle-segment keyword)', () => {
    const input = 'PASSWORD_MIN_LENGTH=8';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact SECRET_ROTATION_DAYS=30 (numeric value, leading-segment keyword)', () => {
    const input = 'SECRET_ROTATION_DAYS=30';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact SECRET_SCAN_ENABLED=true (boolean value, leading-segment keyword)', () => {
    const input = 'SECRET_SCAN_ENABLED=true';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact TOKEN_LIMIT=4096 ("token" is an ambiguous keyword — stays trailing-only, never enters the any-segment detector at all)', () => {
    const input = 'TOKEN_LIMIT=4096';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact monkey=business (mid-word "key" substring, no separator)', () => {
    const input = 'monkey=business';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  // FEAT-463 (AC-3): the quote-tolerant widening must not overtrigger on
  // benign quoted config, quoted numeric/boolean values on any-segment
  // keywords, or a quoted mid-word collision — mirroring the unquoted
  // false-positive guards above, but for the new quoted/JSON-label shapes.
  it('does not redact "NODE_ENV": "production" (benign quoted JSON config)', () => {
    const input = '"NODE_ENV": "production"';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact "PORT": "7777" (benign quoted JSON config)', () => {
    const input = '"PORT": "7777"';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact "PASSWORD_MIN_LENGTH": 8 (quoted label, bare numeric value, middle-segment keyword)', () => {
    const input = '"PASSWORD_MIN_LENGTH": 8';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact "SECRET_SCAN_ENABLED": "true" (quoted label, quoted boolean value, leading-segment keyword)', () => {
    const input = '"SECRET_SCAN_ENABLED": "true"';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact "authtoken": "abc123456789" (quoted mid-word collision, "token" preceded by a letter)', () => {
    const input = '"authtoken": "abc123456789"';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  // FEAT-473: the same three quoted false-positive guards above, repeated
  // with Unicode smart/curly quotes (and one mixed straight/curly combo) —
  // widening the quote character class must not itself widen what counts
  // as a secret; a benign config knob stays benign regardless of which
  // quote style wraps it.
  it('does not redact “NODE_ENV”: “production” (benign curly-quoted JSON config)', () => {
    const input = '“NODE_ENV”: “production”';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact “PASSWORD_MIN_LENGTH”: 8 (curly-quoted label, bare numeric value, middle-segment keyword)', () => {
    const input = '“PASSWORD_MIN_LENGTH”: 8';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact “SECRET_SCAN_ENABLED”: “true” (curly-quoted label, curly-quoted boolean value)', () => {
    const input = '“SECRET_SCAN_ENABLED”: “true”';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact "SECRET_SCAN_ENABLED": “true” (mixed straight-quoted label, curly-quoted boolean value)', () => {
    const input = '"SECRET_SCAN_ENABLED": “true”';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact “authtoken”: “abc123456789” (curly-quoted mid-word collision, "token" preceded by a letter)', () => {
    const input = '“authtoken”: “abc123456789”';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('never re-redacts inside an already-inserted placeholder', () => {
    // "github_token" itself contains the word "token" — must not be caught by
    // the generic_credential detector on a second look.
    const { text, events } = redactText(`token ${GHP_TOKEN} in header`);
    const placeholderCount = (text.match(/\[REDACTED:/g) ?? []).length;
    expect(placeholderCount).toBe(1);
    expect(events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FEAT-468: numeric-secret digit-run heuristic — false-positive corpus.
// Every shape here is a realistic non-secret digit string that must stay
// fully unredacted. The heuristic is length-only (>= 23 consecutive digits,
// no separator, no label prefix — see entropy.ts NUMERIC_SECRET_MIN_LENGTH
// and LABEL_PREFIX_RE), so the discriminator is either: does this shape's
// raw digit run ever reach 23 chars unbroken (timestamps/cards/zip+4/order
// IDs/USPS tracking numbers below), or is it the value-side of a labeled
// assignment (env/YAML/JSON label shapes below)?
// ---------------------------------------------------------------------------

describe('redactText — FEAT-468 numeric-secret false-positive corpus', () => {
  it('does not redact an unbroken 22-digit run (one below the minimum-floor boundary, post-review-fix)', () => {
    const input = 'ref 9876543210987654321098 confirmed';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  // FEAT-468 review round 1 (MEDIUM finding): USPS tracking-number shapes,
  // reproduced live by the reviewer against the un-fixed code — both are
  // exactly the unbroken-unlabeled-digit-run shape this heuristic targets,
  // and both now stay under the raised 23-digit floor.
  it('does not redact a 22-digit USPS Priority/Express tracking number', () => {
    const input = 'your package tracking number is 9400111899223197428490 for delivery';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a 20-digit USPS Certified Mail tracking number', () => {
    const input = 'certified mail 71967398271700000000 delivered';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  // FEAT-468 review round 1 (HIGH finding): labeled numeric values — env
  // style, JSON style, YAML style — must survive regardless of digit-run
  // length. Reproduced live by the reviewer against the un-fixed code
  // (all four leaked in full before the LABEL_PREFIX_RE guard was added).
  it('does not redact an env-style LABEL=digits assignment (non-secret label, digit value far past the floor)', () => {
    const input = 'MAX_RETRIES=9999999999999999999999999';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact an env-style LABEL=digits assignment embedded in prose', () => {
    const input = 'INVOICE_NUMBER=12345678901234567890 was issued last week';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact an env-style LABEL=digits assignment, label containing a secret-adjacent word as a non-trailing shape', () => {
    const input = 'please reference ACCOUNT_NUMBER=98765432109876543210 on your next call';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a JSON-style "label": "digits" value (both sides quoted)', () => {
    const input = '"orderId": "12345678901234567890"';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  // FEAT-473: LABEL_PREFIX_RE (entropy.ts) is widened alongside detectors.ts's
  // quoted entries — a curly-quoted labeled numeric value must be recognized
  // as labeled too, or this heuristic would wrongly flag an ordinary
  // smart-quoted ID/order-number as an unlabeled numeric secret purely
  // because of its quote style.
  it('does not redact a curly-quoted JSON-style “label”: “digits” value (both sides curly-quoted)', () => {
    const input = '“orderId”: “12345678901234567890”';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a mixed-quote JSON-style "label”: “digits" value (curly/straight combo on both label and value)', () => {
    const input = '"orderId”: “12345678901234567890"';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a curly-quoted label with a bare (unquoted) digit value', () => {
    const input = '“orderId”: 12345678901234567890123';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a YAML-style label: digits value (no quotes, colon+space separator)', () => {
    const input = 'trackingId: 12345678901234567890123 confirmed';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  // FEAT-468 review round 2 (LOW fix): same-line scanning has no fixed
  // character cap (unlike the old 40-char window), so arbitrary same-line
  // whitespace padding between a label's separator and its value no longer
  // pushes a real label out of range.
  it('does not redact a labeled value with 40 spaces of same-line padding between separator and value (fixed-width/aligned config shape)', () => {
    const input = `ACCOUNT_NUMBER: ${' '.repeat(40)}12345678901234567890123`;
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  // FEAT-468 review round 2: label-at-line-start with leading indentation —
  // the same-line lookback still finds the label even when the label's own
  // line begins with whitespace (a previous line's trailing newline plus
  // indentation before the label itself), since the label-shape regex
  // isn't anchored to the start of the line slice.
  it('does not redact an indented labeled value on its own line (leading whitespace before the label)', () => {
    const input = 'notes\n  ACCOUNT_NUMBER: 12345678901234567890123';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact an intl phone number with parens/dashes/spaces', () => {
    const input = 'call me at +1 (555) 123-4567 today';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact an intl phone number, dash-grouped (RU-style)', () => {
    const input = 'contact +7 916 123-45-67 for support';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a squashed (no-separator) 10-digit domestic phone number', () => {
    const input = 'reach us at 5551234567 anytime';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a 10-digit unix timestamp (seconds)', () => {
    const input = 'timestamp 1751935200 recorded';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a 13-digit unix timestamp (milliseconds)', () => {
    const input = 'event logged at 1751935200000 in the trace';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a squashed ISO date+time (14 digits, no separators)', () => {
    const input = 'snapshot id 20260710172500 taken';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a squashed ISO date+time+milliseconds (17 digits)', () => {
    const input = 'build tag 20260710172500123 published';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a 16-digit credit-card-shaped test number (Visa test pattern)', () => {
    const input = 'test card 4111111111111111 approved in sandbox';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a 15-digit credit-card-shaped test number (Amex test pattern)', () => {
    const input = 'test card 378282246310005 approved in sandbox';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a squashed zip+4 (9 digits)', () => {
    const input = 'ship to zip 123456789 please';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a dash-formatted order/invoice number', () => {
    const input = 'order ORD-0001234567890 shipped';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a row of space-separated numeric table values', () => {
    const input = 'totals: 1001 2002 3003 4004 5005 6006';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });

  it('does not redact a comma-separated numeric CSV-style row', () => {
    const input = '2026,07,10,17,25,00,1001,2002,3003';
    const { text, events } = redactText(input);
    expect(text).toBe(input);
    expect(events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('redactText — determinism', () => {
  it('same secret in two different texts -> identical placeholder', () => {
    const a = redactText(`token=${GHP_TOKEN}`);
    const b = redactText(`leaked earlier: token=${GHP_TOKEN}`);
    const eventA = a.events.find(e => e.type === 'github_token');
    const eventB = b.events.find(e => e.type === 'github_token');
    expect(eventA?.hash8).toBeDefined();
    expect(eventA?.hash8).toBe(eventB?.hash8);
  });

  it('different secrets -> different hash8', () => {
    const a = redactText(`token=${GHP_TOKEN}`);
    const b = redactText(`token=${GHO_TOKEN}`);
    const eventA = a.events.find(e => e.type === 'github_token');
    const eventB = b.events.find(e => e.type === 'github_token');
    expect(eventA?.hash8).not.toBe(eventB?.hash8);
  });
});

// ---------------------------------------------------------------------------
// Config-off (SEC-9, AC-6 redaction half) — unit level
// ---------------------------------------------------------------------------

describe('redactIfEnabled — respects security.redaction.enabled', () => {
  it('passes text through unchanged when disabled', () => {
    const cfg = defaultConfig();
    cfg.security.redaction.enabled = false;
    const input = `Password=hunter2; token=${GHP_TOKEN}`;
    const { text, events } = redactIfEnabled(input, cfg);
    expect(text).toBe(input);
    expect(events).toEqual([]);
  });

  it('redacts when enabled (default)', () => {
    const cfg = defaultConfig();
    const { text, events } = redactIfEnabled(`token=${GHP_TOKEN}`, cfg);
    expect(text).not.toContain(GHP_TOKEN);
    expect(events.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Integration (AC-3): ingest -> transcripts row + redaction_log, byte-scan DB
// ---------------------------------------------------------------------------

describe('AC-3: POST /ingest/transcript redacts before persistence', () => {
  it('placeholders in stored content; raw secrets nowhere in the DB; redaction_log has counts', async () => {
    const db: DB = openDb(':memory:');
    migrate(db);
    const providers = makeMockProviders();
    const app = await buildApp({ db, token: 'tok', embed: providers.embed });

    const res = await app.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: { authorization: 'Bearer tok' },
      payload: {
        event: 'session_end',
        session_id: 'sess-ac3',
        project_id: 'proj-ac3',
        captured_at: new Date().toISOString(),
        turns: [
          { role: 'user', text: `here is my token ${GHP_TOKEN} and Password=hunter2;` },
        ],
        client_scrub_applied: false,
        client_scrub_hits: 0,
        client_version: '1.0.0',
        client_scrub_version: '1.0.0',
        wire_version: 'v1.0',
      },
    });
    expect(res.statusCode).toBe(200);

    const transcriptRow = db.prepare('SELECT content FROM transcripts WHERE session_id = ?').get('sess-ac3') as { content: string };
    expect(transcriptRow.content).toMatch(/\[REDACTED:github_token:[0-9a-f]{8}\]/);
    expect(transcriptRow.content).toMatch(/\[REDACTED:generic_credential:[0-9a-f]{8}\]/);
    expect(transcriptRow.content).not.toContain(GHP_TOKEN);
    expect(transcriptRow.content).not.toContain('hunter2');

    // Byte-scan: raw secret values must appear nowhere in any TEXT column of any table.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    let dump = '';
    for (const { name } of tables) {
      try {
        const rows = db.prepare(`SELECT * FROM "${name}"`).all();
        dump += JSON.stringify(rows);
      } catch {
        // virtual tables (fts5/vec0) may not support SELECT * cleanly — skip
      }
    }
    expect(dump).not.toContain(GHP_TOKEN);
    expect(dump).not.toContain('hunter2');

    // redaction_log has per-type counts, values never stored.
    const logRows = db.prepare('SELECT type, count FROM redaction_log WHERE session_id = ?').all('sess-ac3') as {
      type: string;
      count: number;
    }[];
    const types = logRows.map(r => r.type);
    expect(types).toContain('github_token');
    expect(types).toContain('generic_credential');
    for (const row of logRows) {
      expect(row.count).toBeGreaterThan(0);
    }

    await app.close();
    db.close();
  });
});
