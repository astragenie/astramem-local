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
];

describe('redactText — true positives (table-driven)', () => {
  it.each(TRUE_POSITIVES)('$name -> type $type', ({ input, type, secret }) => {
    const { text, events } = redactText(input);
    expect(text).not.toContain(secret);
    expect(events.some(e => e.type === type)).toBe(true);
    expect(text).toMatch(new RegExp(`\\[REDACTED:${type}:[0-9a-f]{8}\\]`));
  });

  it('covers at least 25 true-positive fixtures', () => {
    expect(TRUE_POSITIVES.length).toBeGreaterThanOrEqual(25);
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
