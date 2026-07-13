/**
 * Tests for SystemdAdapter — mocks fs + child_process so Linux-specific
 * logic is exercisable on any OS including Windows CI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- fs mock -----------------------------------------------------------------
const fsMock = {
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  unlinkSync: vi.fn(),
};

// ---- child_process mock ------------------------------------------------------
type ExecOptions = { timeout?: number };
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const execMock = vi.fn((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
  cb(null, '', '');
});

vi.mock('node:fs', () => fsMock);
vi.mock('node:child_process', () => ({ exec: execMock }));

// Import AFTER mocks
const { SystemdAdapter } = await import('../../src/service/systemd.js');

describe('SystemdAdapter', () => {
  const adapter = new SystemdAdapter();

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

  it('install writes unit file to ~/.config/systemd/user/', async () => {
    await adapter.install('/usr/local/bin/node /app/dist/cli/index.js', 7777);

    expect(fsMock.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('systemd'),
      expect.objectContaining({ recursive: true })
    );
    expect(fsMock.writeFileSync).toHaveBeenCalledOnce();

    const [path, content] = fsMock.writeFileSync.mock.calls[0] as [string, string];
    expect(path).toMatch(/astra-memoryd\.service$/);
    expect(content).toContain('[Unit]');
    expect(content).toContain('[Service]');
    expect(content).toContain('[Install]');
    expect(content).toContain('ExecStart=');
    expect(content).toContain('7777');
    expect(content).toContain('WantedBy=default.target');
  });

  it('install enables the unit via systemctl --user', async () => {
    await adapter.install('/usr/local/bin/node /app/dist/cli/index.js', 7777);

    const cmds = execMock.mock.calls.map(c => c[0] as string);
    const enableCall = cmds.find(c => c.includes('enable'));
    expect(enableCall).toBeTruthy();
    expect(enableCall).toContain('systemctl --user');
    expect(enableCall).toContain('astra-memoryd');
  });

  it('uninstall removes unit file if present', async () => {
    fsMock.existsSync.mockReturnValue(true);
    await adapter.uninstall();

    const cmds = execMock.mock.calls.map(c => c[0] as string);
    const disableCall = cmds.find(c => c.includes('disable') || c.includes('stop'));
    expect(disableCall).toBeTruthy();
    expect(fsMock.unlinkSync).toHaveBeenCalledOnce();
  });

  it('start calls systemctl --user start', async () => {
    await adapter.start();
    const cmds = execMock.mock.calls.map(c => c[0] as string);
    expect(cmds.some(c => c.includes('systemctl --user start') && c.includes('astra-memoryd'))).toBe(true);
  });

  it('stop calls systemctl --user stop', async () => {
    await adapter.stop();
    const cmds = execMock.mock.calls.map(c => c[0] as string);
    expect(cmds.some(c => c.includes('systemctl --user stop') && c.includes('astra-memoryd'))).toBe(true);
  });

  it('status returns installed=true when unit file exists', async () => {
    fsMock.existsSync.mockReturnValue(true);
    // Mock is-active returning 'active'
    execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
      cb(null, 'active', '');
    });

    const s = await adapter.status();
    expect(s.installed).toBe(true);
  });

  it('status returns installed=false when unit file absent', async () => {
    fsMock.existsSync.mockReturnValue(false);
    const s = await adapter.status();
    expect(s.installed).toBe(false);
  });

  // B3 review (2026-07-13): status() used to collapse EVERY is-active
  // failure (timeout, missing binary, DBus down, or a genuine 'inactive')
  // into a hardcoded `running: false, detail: 'inactive'` — a query
  // failure and a confirmed-inactive service were the same observable
  // state. These pin the fix.
  it('a timeout on the is-active query reports inconclusive, NOT a confident "inactive"', async () => {
    fsMock.existsSync.mockReturnValue(true);
    execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
      const err = Object.assign(new Error('Command failed: systemctl --user is-active astra-memoryd\nETIMEDOUT'), {
        signal: 'SIGTERM',
        code: null,
      });
      cb(err, '', '');
    });

    const s = await adapter.status();
    expect(s.installed).toBe(true);
    expect(s.inconclusive).toBe(true);
    expect(s.running).toBe(false);
    // Must never claim the pre-fix hardcoded "inactive" — that would be
    // indistinguishable from a real query success.
    expect(s.detail).not.toBe('inactive');
  });

  it('systemctl binary missing (ENOENT) also reports inconclusive', async () => {
    fsMock.existsSync.mockReturnValue(true);
    execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
      const err = Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT', signal: null });
      cb(err, '', '');
    });

    const s = await adapter.status();
    expect(s.inconclusive).toBe(true);
  });

  it('a genuine non-active state (systemctl completed, exited non-zero) is reported as a real "inactive", not inconclusive', async () => {
    fsMock.existsSync.mockReturnValue(true);
    execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
      // is-active exits non-zero for 'inactive' but still prints it — no
      // signal, no ENOENT: the command ran to completion and answered.
      const err = Object.assign(new Error('Command failed: systemctl --user is-active astra-memoryd'), {
        code: 3,
        signal: null,
      });
      cb(err, 'inactive', '');
    });

    const s = await adapter.status();
    expect(s.inconclusive).toBeFalsy();
    expect(s.running).toBe(false);
    expect(s.detail).toBe('inactive');
  });

  // FEAT-443 SLICE-2 — hang-watchdog probe timer
  describe('watchdog timer', () => {
    it('installWatchdogTimer writes a oneshot service + OnUnitActiveSec timer', async () => {
      await adapter.installWatchdogTimer('/usr/local/bin/node /app/dist/cli/index.js', 180);

      expect(fsMock.writeFileSync).toHaveBeenCalledTimes(2);
      const [svcPath, svcContent] = fsMock.writeFileSync.mock.calls[0] as [string, string];
      const [timerPath, timerContent] = fsMock.writeFileSync.mock.calls[1] as [string, string];

      expect(svcPath).toMatch(/astra-memoryd-watchdog\.service$/);
      expect(svcContent).toContain('Type=oneshot');
      expect(svcContent).toContain('service watchdog-probe');

      expect(timerPath).toMatch(/astra-memoryd-watchdog\.timer$/);
      expect(timerContent).toContain('OnUnitActiveSec=180s');
      expect(timerContent).toContain('[Timer]');
    });

    it('installWatchdogTimer enables the timer via systemctl --user', async () => {
      await adapter.installWatchdogTimer('/usr/local/bin/node /app/dist/cli/index.js', 180);
      const cmds = execMock.mock.calls.map(c => c[0] as string);
      expect(cmds.some(c => c.includes('systemctl --user') && c.includes('enable') && c.includes('watchdog.timer'))).toBe(true);
    });

    it('uninstallWatchdogTimer removes both unit files when present', async () => {
      fsMock.existsSync.mockReturnValue(true);
      await adapter.uninstallWatchdogTimer();
      expect(fsMock.unlinkSync).toHaveBeenCalledTimes(2);
    });

    it('uninstallWatchdogTimer is a no-op when nothing was installed', async () => {
      fsMock.existsSync.mockReturnValue(false);
      await adapter.uninstallWatchdogTimer();
      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    });
  });
});
