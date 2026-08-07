/**
 * FEAT-476 Phase 0 — the proxy-side cost-spool writer/reader
 * (src/capture/cost-spool.ts). Round-trip + tolerance coverage, independent
 * of the drain worker (tests/ingest/cost-spool-drain.test.ts) and of
 * finishCapture() itself (tests/capture/proxy.test.ts's AC-5 case).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  costSpoolDir, writeCostSpoolEntry, listCostSpoolFiles, readCostSpoolEntry, deleteCostSpoolFile,
} from '../../src/capture/cost-spool.js';

const dirs: string[] = [];
function tempDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cost-spool-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('writeCostSpoolEntry / listCostSpoolFiles / readCostSpoolEntry', () => {
  it('writes a file that round-trips through readCostSpoolEntry, tagged source: proxy', () => {
    const dir = tempDataDir();
    writeCostSpoolEntry(dir, {
      capturedAtMs: 1_700_000_000_000,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      stopReason: 'end_turn',
      truncated: false,
      sessionKey: 'proxy-abc',
      agentRole: null,
    });

    const files = listCostSpoolFiles(dir);
    expect(files).toHaveLength(1);
    const entry = readCostSpoolEntry(files[0]!.path);
    expect(entry).toEqual({
      source: 'proxy',
      capturedAtMs: 1_700_000_000_000,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      stopReason: 'end_turn',
      truncated: false,
      sessionKey: 'proxy-abc',
      agentRole: null,
    });
  });

  it('creates the spool directory on first write', () => {
    const dir = tempDataDir();
    expect(listCostSpoolFiles(dir)).toEqual([]); // dir doesn't exist yet — tolerant
    writeCostSpoolEntry(dir, {
      capturedAtMs: 1, provider: 'anthropic', model: null, inputTokens: null, outputTokens: null,
      cacheReadInputTokens: null, cacheCreationInputTokens: null, stopReason: null, truncated: false,
      sessionKey: 'proxy-1', agentRole: null,
    });
    expect(listCostSpoolFiles(dir)).toHaveLength(1);
  });

  it('lists files oldest-first by their capturedAtMs-prefixed filename', () => {
    const dir = tempDataDir();
    writeCostSpoolEntry(dir, { capturedAtMs: 200, provider: 'a', model: null, inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null, stopReason: null, truncated: false, sessionKey: 'proxy-2', agentRole: null });
    writeCostSpoolEntry(dir, { capturedAtMs: 100, provider: 'a', model: null, inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null, stopReason: null, truncated: false, sessionKey: 'proxy-1', agentRole: null });
    const files = listCostSpoolFiles(dir);
    expect(files.map(f => f.name[0])).toEqual(['1', '2']); // "100-..." sorts before "200-..."
  });

  it('readCostSpoolEntry tolerates a malformed file, returning null rather than throwing', () => {
    const dir = tempDataDir();
    mkdirSync(costSpoolDir(dir), { recursive: true });
    const badPath = join(costSpoolDir(dir), '1-bad.json');
    writeFileSync(badPath, 'not json at all');
    expect(readCostSpoolEntry(badPath)).toBeNull();
  });

  it('readCostSpoolEntry rejects a shape missing required fields', () => {
    const dir = tempDataDir();
    mkdirSync(costSpoolDir(dir), { recursive: true });
    const badPath = join(costSpoolDir(dir), '1-incomplete.json');
    writeFileSync(badPath, JSON.stringify({ source: 'proxy' })); // missing capturedAtMs/provider/sessionKey
    expect(readCostSpoolEntry(badPath)).toBeNull();
  });

  it('deleteCostSpoolFile removes the file and is a safe no-op if already gone', () => {
    const dir = tempDataDir();
    writeCostSpoolEntry(dir, { capturedAtMs: 1, provider: 'a', model: null, inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null, stopReason: null, truncated: false, sessionKey: 'proxy-1', agentRole: null });
    const files = listCostSpoolFiles(dir);
    deleteCostSpoolFile(files[0]!.path);
    expect(listCostSpoolFiles(dir)).toHaveLength(0);
    expect(() => deleteCostSpoolFile(files[0]!.path)).not.toThrow();
  });
});
