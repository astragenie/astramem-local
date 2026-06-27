/**
 * Tests for SchtasksAdapter — mocks child_process to verify exact
 * schtasks.exe argument construction without UAC or live scheduler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type ExecOptions = { timeout?: number };
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const execMock = vi.fn((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
  cb(null, '', '');
});

// fsMock needed for status() existsSync check in schtasks
const fsMock = {
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
};

vi.mock('node:child_process', () => ({ exec: execMock }));
vi.mock('node:fs', () => fsMock);

const { SchtasksAdapter } = await import('../../src/service/schtasks.js');

describe('SchtasksAdapter', () => {
  const adapter = new SchtasksAdapter();
  const TASK_NAME = 'AstraMemoryD';

  beforeEach(() => {
    vi.clearAllMocks();
    execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
      cb(null, '', '');
    });
    fsMock.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('install creates schtasks /create with /sc onlogon and task name', async () => {
    await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);

    const cmds = execMock.mock.calls.map(c => c[0] as string);
    const createCall = cmds.find(c => c.toLowerCase().includes('schtasks') && c.toLowerCase().includes('/create'));
    expect(createCall).toBeTruthy();
    expect(createCall).toMatch(/\/sc\s+onlogon/i);
    expect(createCall).toContain(TASK_NAME);
    // verify port ends up in the command
    expect(createCall).toContain('7777');
    // no /ru SYSTEM or elevation — user-scope, no UAC
    expect(createCall?.toLowerCase()).not.toContain('system');
  });

  it('install uses /f to force overwrite if already registered', async () => {
    await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
    const cmds = execMock.mock.calls.map(c => c[0] as string);
    const createCall = cmds.find(c => c.toLowerCase().includes('/create'));
    expect(createCall).toMatch(/\/f/i);
  });

  it('uninstall calls schtasks /delete', async () => {
    await adapter.uninstall();
    const cmds = execMock.mock.calls.map(c => c[0] as string);
    const deleteCall = cmds.find(c => c.toLowerCase().includes('schtasks') && c.toLowerCase().includes('/delete'));
    expect(deleteCall).toBeTruthy();
    expect(deleteCall).toContain(TASK_NAME);
    expect(deleteCall).toMatch(/\/f/i);
  });

  it('start calls schtasks /run', async () => {
    await adapter.start();
    const cmds = execMock.mock.calls.map(c => c[0] as string);
    const runCall = cmds.find(c => c.toLowerCase().includes('schtasks') && c.toLowerCase().includes('/run'));
    expect(runCall).toBeTruthy();
    expect(runCall).toContain(TASK_NAME);
  });

  it('stop calls schtasks /end or taskkill', async () => {
    await adapter.stop();
    const cmds = execMock.mock.calls.map(c => c[0] as string);
    const stopCall = cmds.find(c =>
      (c.toLowerCase().includes('schtasks') && c.toLowerCase().includes('/end')) ||
      c.toLowerCase().includes('taskkill')
    );
    expect(stopCall).toBeTruthy();
  });

  it('status: running=true when query output contains Running', async () => {
    execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
      cb(null, 'TaskName: AstraMemoryD\nStatus: Running\n', '');
    });
    const s = await adapter.status();
    expect(s.installed).toBe(true);
    expect(s.running).toBe(true);
  });

  it('status: installed=false + running=false when task not found', async () => {
    execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
      cb(new Error('task not found'), '', 'ERROR: The system cannot find the file specified.');
    });
    const s = await adapter.status();
    expect(s.installed).toBe(false);
    expect(s.running).toBe(false);
  });
});
