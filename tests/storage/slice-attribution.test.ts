/**
 * FEAT-476 AC-7 — attributeSlice's own bucketing logic + readWorkflowStateWindows'
 * file-parsing tolerance, isolated from the report layer.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { attributeSlice, readWorkflowStateWindows, type WorkflowStateWindow } from '../../src/storage/slice-attribution.js';

describe('attributeSlice', () => {
  const w: WorkflowStateWindow[] = [
    { sliceId: 'SLICE-1', startedAtMs: 100, endedAtMs: 200 },
    { sliceId: 'SLICE-2', startedAtMs: 500, endedAtMs: 600 },
  ];

  it('zero matching windows -> unattributed', () => {
    expect(attributeSlice(w, 300)).toEqual({ bucket: 'unattributed', sliceId: null, candidates: null });
  });

  it('exactly one matching window -> slice', () => {
    expect(attributeSlice(w, 150)).toEqual({ bucket: 'slice', sliceId: 'SLICE-1', candidates: null });
  });

  it('boundary timestamps are inclusive', () => {
    expect(attributeSlice(w, 100).bucket).toBe('slice');
    expect(attributeSlice(w, 200).bucket).toBe('slice');
  });

  it('more than one matching window -> ambiguous with the real candidate count', () => {
    const overlapping: WorkflowStateWindow[] = [
      { sliceId: 'A', startedAtMs: 0, endedAtMs: 1000 },
      { sliceId: 'B', startedAtMs: 0, endedAtMs: 1000 },
      { sliceId: 'C', startedAtMs: 0, endedAtMs: 1000 },
    ];
    expect(attributeSlice(overlapping, 500)).toEqual({ bucket: 'ambiguous', sliceId: null, candidates: 3 });
  });

  it('an open window (endedAtMs null) is treated as extending to nowMs', () => {
    const open: WorkflowStateWindow[] = [{ sliceId: 'LIVE', startedAtMs: 100, endedAtMs: null }];
    expect(attributeSlice(open, 5000, /* nowMs */ 10000).bucket).toBe('slice');
    expect(attributeSlice(open, 20000, /* nowMs */ 10000).bucket).toBe('unattributed');
  });
});

describe('readWorkflowStateWindows', () => {
  function tempRepoRoot(): string {
    return mkdtempSync(join(tmpdir(), 'slice-attribution-test-'));
  }
  function writeWorkflowState(repoRoot: string, content: unknown): void {
    const dir = join(repoRoot, '.claude', 'state', 'crew');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workflow-state.json'), JSON.stringify(content));
  }

  it('returns an empty array when the file is missing — never throws', () => {
    const root = tempRepoRoot();
    expect(readWorkflowStateWindows(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('returns an empty array on malformed JSON — never throws', () => {
    const root = tempRepoRoot();
    mkdirSync(join(root, '.claude', 'state', 'crew'), { recursive: true });
    writeFileSync(join(root, '.claude', 'state', 'crew', 'workflow-state.json'), '{not valid json');
    expect(readWorkflowStateWindows(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('parses currentRun + recentRuns into flat windows, extracting SLICE-NNN from the title', () => {
    const root = tempRepoRoot();
    writeWorkflowState(root, {
      currentRun: { title: 'FEAT548 SLICE441: Implement FEAT-548', startedAt: '2026-08-01T10:00:00.000Z' },
      recentRuns: [
        { title: 'FEAT550 SLICE440: Implement FEAT-550', startedAt: '2026-07-18T02:51:02.834Z', completedAt: '2026-07-18T02:55:00.000Z' },
      ],
    });
    const windows = readWorkflowStateWindows(root);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({ sliceId: 'SLICE-441', startedAtMs: Date.parse('2026-08-01T10:00:00.000Z'), endedAtMs: null });
    expect(windows[1]).toEqual({
      sliceId: 'SLICE-440',
      startedAtMs: Date.parse('2026-07-18T02:51:02.834Z'),
      endedAtMs: Date.parse('2026-07-18T02:55:00.000Z'),
    });
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to the raw title when no SLICE-NNN pattern is found', () => {
    const root = tempRepoRoot();
    writeWorkflowState(root, {
      currentRun: { title: 'Ad-hoc investigation, no slice', startedAt: '2026-08-01T10:00:00.000Z' },
    });
    const windows = readWorkflowStateWindows(root);
    expect(windows[0]!.sliceId).toBe('Ad-hoc investigation, no slice');
    rmSync(root, { recursive: true, force: true });
  });

  it('skips malformed individual run entries without discarding the whole file', () => {
    const root = tempRepoRoot();
    writeWorkflowState(root, {
      currentRun: { title: 'Good run', startedAt: '2026-08-01T10:00:00.000Z' },
      recentRuns: [{ title: 'Missing startedAt' }, { startedAt: '2026-01-01T00:00:00Z' }],
    });
    const windows = readWorkflowStateWindows(root);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.sliceId).toBe('Good run');
    rmSync(root, { recursive: true, force: true });
  });
});
