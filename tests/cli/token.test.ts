import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { generateToken, rotateToken } from '../../src/cli/token.js';

function tmpSecretsPath(): string {
  const dir = join(tmpdir(), `astra-token-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'secrets.env');
}

describe('generateToken', () => {
  it('returns a 64-character hex string', () => {
    const tok = generateToken();
    expect(tok).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(tok)).toBe(true);
  });

  it('generates unique tokens on each call', () => {
    const t1 = generateToken();
    const t2 = generateToken();
    expect(t1).not.toBe(t2);
  });
});

describe('rotateToken', () => {
  it('writes a new 64-char hex token to secrets.env', () => {
    const path = tmpSecretsPath();
    const token = rotateToken(path);
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain(`MEMORY_BEARER=${token}`);
  });

  it('sets file mode 0600 on Unix', () => {
    if (platform() === 'win32') return; // skip mode check on Windows
    const path = tmpSecretsPath();
    rotateToken(path);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('generates a fresh token each call (invalidates old)', () => {
    const path = tmpSecretsPath();
    const t1 = rotateToken(path);
    const t2 = rotateToken(path);
    expect(t1).not.toBe(t2);
    // File contains the latest token
    const content = readFileSync(path, 'utf8');
    expect(content).toContain(`MEMORY_BEARER=${t2}`);
    expect(content).not.toContain(`MEMORY_BEARER=${t1}`);
  });

  it('preserves existing azure keys when rotating', async () => {
    const path = tmpSecretsPath();
    const { writeSecrets } = await import('../../src/config/secrets.js');
    writeSecrets({ bearer: 'oldtoken', azureKey: 'myazurekey', azureEndpoint: 'https://ep.openai.azure.com' }, path);

    const newToken = rotateToken(path);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain(`MEMORY_BEARER=${newToken}`);
    expect(content).toContain('AZURE_OPENAI_API_KEY=myazurekey');
    expect(content).toContain('AZURE_OPENAI_ENDPOINT=https://ep.openai.azure.com');
  });
});
