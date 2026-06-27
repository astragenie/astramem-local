import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { writeSecrets } from '../../src/config/secrets.js';

function tmpPath(filename = 'secrets.env'): string {
  const dir = join(tmpdir(), `astra-secrets-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, filename);
}

describe('writeSecrets', () => {
  it('writes MEMORY_BEARER line', () => {
    const path = tmpPath();
    writeSecrets({ bearer: 'abc123' }, path);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('MEMORY_BEARER=abc123');
  });

  it('writes optional azure fields when provided', () => {
    const path = tmpPath();
    writeSecrets({
      bearer: 'tok',
      azureKey: 'mykey',
      azureEndpoint: 'https://test.openai.azure.com',
      azureDeployment: 'gpt4',
    }, path);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('AZURE_OPENAI_API_KEY=mykey');
    expect(content).toContain('AZURE_OPENAI_ENDPOINT=https://test.openai.azure.com');
    expect(content).toContain('AZURE_OPENAI_DEPLOYMENT=gpt4');
  });

  it('omits azure fields when not provided', () => {
    const path = tmpPath();
    writeSecrets({ bearer: 'tok' }, path);
    const content = readFileSync(path, 'utf8');
    expect(content).not.toContain('AZURE_OPENAI');
  });

  it('creates parent directory if missing', () => {
    const dir = join(tmpdir(), `astra-secrets-deep-${randomUUID()}`, 'nested', 'dir');
    const path = join(dir, 'secrets.env');
    writeSecrets({ bearer: 'tok' }, path);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('MEMORY_BEARER=tok');
  });

  it('sets file mode 0600 on Unix', () => {
    if (platform() === 'win32') return; // Windows: skip mode check
    const path = tmpPath();
    writeSecrets({ bearer: 'tok' }, path);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
