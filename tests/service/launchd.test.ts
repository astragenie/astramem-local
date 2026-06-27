/**
 * Tests for LaunchdAdapter — mocks fs + child_process so macOS-specific
 * logic is exercisable on Windows CI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fsMock = {
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
};

type ExecOptions = { timeout?: number };
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const execMock = vi.fn((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
  cb(null, '', '');
});

vi.mock('node:fs', () => fsMock);
vi.mock('node:child_process', () => ({ exec: execMock }));

const { LaunchdAdapter } = await import('../../src/service/launchd.js');

describe('LaunchdAdapter', () => {
  const adapter = new LaunchdAdapter();

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

  it('install writes plist to ~/Library/LaunchAgents/', async () => {
    await adapter.install('/usr/local/bin/node /app/dist/cli/index.js', 7777);

    expect(fsMock.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('LaunchAgents'),
      expect.objectContaining({ recursive: true })
    );
    expect(fsMock.writeFileSync).toHaveBeenCalledOnce();

    const [path, content] = fsMock.writeFileSync.mock.calls[0] as [string, string];
    expect(path).toMatch(/com\.astragenie\.astra-memoryd\.plist$/);
    expect(content).toContain('<key>Label</key>');
    expect(content).toContain('com.astragenie.astra-memoryd');
    expect(content).toContain('<key>RunAtLoad</key>');
    expect(content).toContain('<true/>');
    expect(content).toContain('<key>KeepAlive</key>');
    expect(content).toContain('7777');
  });

  it('install bootstraps via launchctl', async () => {
    await adapter.install('/usr/local/bin/node /app/dist/cli/index.js', 7777);

    const cmds = execMock.mock.calls.map(c => c[0] as string);
    const bootstrapCall = cmds.find(c => c.includes('launchctl') && (c.includes('bootstrap') || c.includes('load')));
    expect(bootstrapCall).toBeTruthy();
  });

  it('uninstall bootout/unload removes plist', async () => {
    fsMock.existsSync.mockReturnValue(true);
    await adapter.uninstall();

    const cmds = execMock.mock.calls.map(c => c[0] as string);
    const unloadCall = cmds.find(c => c.includes('launchctl') && (c.includes('bootout') || c.includes('unload') || c.includes('remove')));
    expect(unloadCall).toBeTruthy();
    expect(fsMock.unlinkSync).toHaveBeenCalledOnce();
  });

  it('start calls launchctl bootstrap or kickstart', async () => {
    await adapter.start();
    const cmds = execMock.mock.calls.map(c => c[0] as string);
    expect(cmds.some(c => c.includes('launchctl'))).toBe(true);
  });

  it('stop calls launchctl bootout or stop', async () => {
    await adapter.stop();
    const cmds = execMock.mock.calls.map(c => c[0] as string);
    expect(cmds.some(c => c.includes('launchctl'))).toBe(true);
  });

  it('status returns installed=true when plist exists', async () => {
    fsMock.existsSync.mockReturnValue(true);
    execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
      cb(null, 'running = 1;', '');
    });
    const s = await adapter.status();
    expect(s.installed).toBe(true);
  });

  it('status returns installed=false when plist absent', async () => {
    fsMock.existsSync.mockReturnValue(false);
    const s = await adapter.status();
    expect(s.installed).toBe(false);
    expect(s.running).toBe(false);
  });
});
