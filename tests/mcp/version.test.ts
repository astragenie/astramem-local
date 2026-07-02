import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PKG_VERSION } from '../../src/server/lib/wire-meta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('MCP server version', () => {
  it('mcp/server.ts carries no hardcoded DAEMON_VERSION literal', () => {
    const src = readFileSync(join(__dirname, '../../src/mcp/server.ts'), 'utf8');
    expect(src).not.toMatch(/DAEMON_VERSION\s*=\s*'\d/);
    expect(src).toContain('PKG_VERSION');
  });

  it('PKG_VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
    expect(PKG_VERSION).toBe(pkg.version);
  });
});
