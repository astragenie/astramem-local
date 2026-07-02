/**
 * Tests for SchtasksAdapter — mocks child_process and node:fs to verify
 * the three-tier install ladder and honest start/stop/status behaviour
 * without UAC or a live Windows Task Scheduler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type ExecOptions = { timeout?: number };
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const execMock = vi.fn((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
  cb(null, '', '');
});

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
    // Default: all exec calls succeed
    execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
      cb(null, '', '');
    });
    fsMock.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // install() — three-tier ladder
  // ---------------------------------------------------------------------------

  describe('install — Tier A (no /RU)', () => {
    it('returns { kind: "task" } when Tier A succeeds', async () => {
      const result = await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      expect(result).toEqual({ kind: 'task' });
    });

    it('Tier A command has /sc onlogon, task name, port, /RL LIMITED, /f — but no /RU', async () => {
      await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      const cmds = execMock.mock.calls.map(c => c[0] as string);
      const createCall = cmds.find(
        c => c.toLowerCase().includes('schtasks') && c.toLowerCase().includes('/create'),
      );
      expect(createCall).toBeTruthy();
      expect(createCall).toMatch(/\/sc\s+onlogon/i);
      expect(createCall).toContain(TASK_NAME);
      expect(createCall).toContain('7777');
      expect(createCall).toMatch(/\/RL\s+LIMITED/i);
      expect(createCall).toMatch(/\/f/i);
      // Tier A must NOT include /RU
      expect(createCall?.toUpperCase()).not.toContain('/RU');
    });

    it('does not fall through to Startup shortcut on Tier A success', async () => {
      await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('install — Tier B (/RU /IT fallback)', () => {
    beforeEach(() => {
      // Tier B only emits /RU when USERNAME is set — true on real Windows,
      // absent on Linux/macOS CI runners (they use USER). Pin it.
      vi.stubEnv('USERNAME', 'testuser');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('returns { kind: "task" } when Tier A fails but Tier B succeeds', async () => {
      let callCount = 0;
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        callCount++;
        if (callCount === 1) {
          // Tier A: query check or create — fail the first /create
          cb(new Error('Access denied'), '', 'Access denied');
        } else {
          cb(null, '', '');
        }
      });

      const result = await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      expect(result).toEqual({ kind: 'task' });
    });

    it('Tier B command includes /RU and /IT', async () => {
      // Make Tier A fail so we fall to Tier B
      let tierAFailed = false;
      execMock.mockImplementation((cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        if (!tierAFailed && cmd.toLowerCase().includes('/create') && !cmd.toUpperCase().includes('/RU')) {
          tierAFailed = true;
          cb(new Error('Access denied'), '', 'Access denied');
        } else {
          cb(null, '', '');
        }
      });

      await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);

      const cmds = execMock.mock.calls.map(c => c[0] as string);
      const tierBCall = cmds.find(
        c =>
          c.toLowerCase().includes('schtasks') &&
          c.toLowerCase().includes('/create') &&
          c.toUpperCase().includes('/RU'),
      );
      expect(tierBCall).toBeTruthy();
      expect(tierBCall).toMatch(/\/IT/i);
    });

    it('does not write Startup shortcut when Tier B succeeds', async () => {
      let tierAFailed = false;
      execMock.mockImplementation((cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        if (!tierAFailed && cmd.toLowerCase().includes('/create') && !cmd.toUpperCase().includes('/RU')) {
          tierAFailed = true;
          cb(new Error('Access denied'), '', 'Access denied');
        } else {
          cb(null, '', '');
        }
      });

      await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('install — Tier C (Startup shortcut fallback)', () => {
    beforeEach(() => {
      // Both Tier A and Tier B schtasks /create calls fail
      execMock.mockImplementation((cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        if (cmd.toLowerCase().includes('/create')) {
          cb(new Error('Access denied'), '', 'Access denied');
        } else {
          cb(null, '', '');
        }
      });
    });

    it('returns { kind: "startup", path: <string> } when both tiers fail', async () => {
      const result = await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      expect(result.kind).toBe('startup');
      if (result.kind === 'startup') {
        expect(result.path).toMatch(/AstraMemoryD\.cmd$/i);
      }
    });

    it('writes a .cmd Startup shortcut containing the exec path and port', async () => {
      await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      expect(fsMock.writeFileSync).toHaveBeenCalledOnce();
      const [writePath, content] = fsMock.writeFileSync.mock.calls[0] as [string, string];
      expect(writePath).toMatch(/AstraMemoryD\.cmd$/i);
      expect(content).toContain('7777');
      expect(content).toContain('C:\\app\\dist\\cli\\index.js');
    });

    it('creates the Startup directory if it does not exist', async () => {
      fsMock.existsSync.mockReturnValue(false);
      await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      expect(fsMock.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });
  });

  // ---------------------------------------------------------------------------
  // uninstall()
  // ---------------------------------------------------------------------------

  describe('uninstall', () => {
    it('calls schtasks /delete /f', async () => {
      await adapter.uninstall();
      const cmds = execMock.mock.calls.map(c => c[0] as string);
      const deleteCall = cmds.find(
        c => c.toLowerCase().includes('schtasks') && c.toLowerCase().includes('/delete'),
      );
      expect(deleteCall).toBeTruthy();
      expect(deleteCall).toContain(TASK_NAME);
      expect(deleteCall).toMatch(/\/f/i);
    });

    it('removes Startup shortcut when it exists', async () => {
      fsMock.existsSync.mockReturnValue(true);
      await adapter.uninstall();
      expect(fsMock.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/AstraMemoryD\.cmd$/i));
    });

    it('does not call unlinkSync when Startup shortcut is absent', async () => {
      fsMock.existsSync.mockReturnValue(false);
      await adapter.uninstall();
      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    });

    it('does not throw when schtasks /delete fails (task absent — idempotent)', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        cb(new Error('task not found'), '', 'The system cannot find the file specified');
      });
      await expect(adapter.uninstall()).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // start()
  // ---------------------------------------------------------------------------

  describe('start', () => {
    it('calls schtasks /run when task exists', async () => {
      // First call (taskExists query) succeeds, second (/run) succeeds
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        cb(null, 'TaskName: AstraMemoryD\nStatus: Ready\n', '');
      });
      await adapter.start();
      const cmds = execMock.mock.calls.map(c => c[0] as string);
      const runCall = cmds.find(
        c => c.toLowerCase().includes('schtasks') && c.toLowerCase().includes('/run'),
      );
      expect(runCall).toBeTruthy();
      expect(runCall).toContain(TASK_NAME);
    });

    it('throws with startup-shortcut hint when task missing and shortcut present', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        cb(new Error('task not found'), '', 'ERROR: The system cannot find the file specified');
      });
      fsMock.existsSync.mockReturnValue(true); // Startup shortcut present

      await expect(adapter.start()).rejects.toThrow(/Startup-shortcut fallback/i);
    });

    it('throws generic "not installed" hint when task and shortcut are both absent', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        cb(new Error('task not found'), '', 'ERROR: The system cannot find the file specified');
      });
      fsMock.existsSync.mockReturnValue(false);

      await expect(adapter.start()).rejects.toThrow(/service install/i);
    });
  });

  // ---------------------------------------------------------------------------
  // stop()
  // ---------------------------------------------------------------------------

  describe('stop', () => {
    it('calls schtasks /end when task exists', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        cb(null, 'TaskName: AstraMemoryD\nStatus: Running\n', '');
      });
      await adapter.stop();
      const cmds = execMock.mock.calls.map(c => c[0] as string);
      const endCall = cmds.find(
        c => c.toLowerCase().includes('schtasks') && c.toLowerCase().includes('/end'),
      );
      expect(endCall).toBeTruthy();
      expect(endCall).toContain(TASK_NAME);
    });

    it('throws with startup-shortcut hint when task missing and shortcut present', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        cb(new Error('task not found'), '', 'ERROR');
      });
      fsMock.existsSync.mockReturnValue(true);

      await expect(adapter.stop()).rejects.toThrow(/Startup-shortcut fallback/i);
    });

    it('throws generic hint when neither task nor shortcut exists', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        cb(new Error('task not found'), '', 'ERROR');
      });
      fsMock.existsSync.mockReturnValue(false);

      await expect(adapter.stop()).rejects.toThrow(/service install/i);
    });
  });

  // ---------------------------------------------------------------------------
  // status()
  // ---------------------------------------------------------------------------

  describe('status', () => {
    it('returns running=true when query output contains "Running"', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        cb(null, 'TaskName: AstraMemoryD\nStatus: Running\n', '');
      });
      const s = await adapter.status();
      expect(s.installed).toBe(true);
      expect(s.running).toBe(true);
    });

    it('returns running=false, installed=true when task exists but is not running', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        cb(null, 'TaskName: AstraMemoryD\nStatus: Ready\n', '');
      });
      const s = await adapter.status();
      expect(s.installed).toBe(true);
      expect(s.running).toBe(false);
    });

    it('returns installed=true + detail mentions startup shortcut when task absent but shortcut present', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        cb(new Error('task not found'), '', 'ERROR: The system cannot find the file specified');
      });
      fsMock.existsSync.mockReturnValue(true); // shortcut present

      const s = await adapter.status();
      expect(s.installed).toBe(true);
      expect(s.running).toBe(false);
      expect(s.detail).toMatch(/Startup shortcut/i);
      expect(s.detail).toMatch(/service start.*will NOT work/i);
    });

    it('returns installed=false when task absent and shortcut absent', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        cb(new Error('task not found'), '', 'ERROR: The system cannot find the file specified');
      });
      fsMock.existsSync.mockReturnValue(false);

      const s = await adapter.status();
      expect(s.installed).toBe(false);
      expect(s.running).toBe(false);
    });
  });
});
