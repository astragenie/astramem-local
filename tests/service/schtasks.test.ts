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
  // install() — four-tier ladder: XML → CLI (no /RU) → CLI (/RU /IT) → shortcut
  // ---------------------------------------------------------------------------

  /** Fail every exec whose command matches `pattern`; succeed the rest. */
  function failMatching(pattern: RegExp) {
    execMock.mockImplementation((cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
      if (pattern.test(cmd)) cb(new Error('Access denied'), '', 'ERROR: Access is denied.');
      else cb(null, '', '');
    });
  }

  describe('install — Tier 0 (XML registration)', () => {
    it('returns { kind: "task" } and registers via /xml', async () => {
      const result = await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      expect(result).toEqual({ kind: 'task' });
      const cmds = execMock.mock.calls.map(c => c[0] as string);
      const createCall = cmds.find(
        c => c.toLowerCase().includes('schtasks') && c.toLowerCase().includes('/create'),
      );
      expect(createCall).toBeTruthy();
      expect(createCall).toMatch(/\/xml/i);
      expect(createCall).toContain(TASK_NAME);
      expect(createCall).toMatch(/\/f/i);
    });

    it('writes task XML with no execution limit + 5-minute keepalive repetition', async () => {
      await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      const xmlWrite = fsMock.writeFileSync.mock.calls.find(
        ([p]) => String(p).match(/AstraMemoryD\.xml$/i),
      );
      expect(xmlWrite).toBeTruthy();
      // Content is a UTF-16LE Buffer with BOM — decode to inspect.
      const buf = xmlWrite![1] as Buffer;
      const xml = buf.subarray(2).toString('utf16le');
      expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
      expect(xml).toContain('<Interval>PT5M</Interval>');
      expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
      expect(xml).toContain('serve --port 7777');
    });

    it('does not write a Startup shortcut on XML success', async () => {
      await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      const cmdWrites = fsMock.writeFileSync.mock.calls.filter(
        ([p]) => String(p).match(/\.cmd$/i),
      );
      expect(cmdWrites).toHaveLength(0);
    });
  });

  describe('install — Tier A (CLI fallback, no /RU)', () => {
    it('falls back to /sc onlogon CLI form when the XML tier fails', async () => {
      failMatching(/\/xml/i);
      const result = await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      expect(result).toEqual({ kind: 'task' });
      const cmds = execMock.mock.calls.map(c => c[0] as string);
      const tierACall = cmds.find(
        c => c.toLowerCase().includes('/create') && !c.toLowerCase().includes('/xml'),
      );
      expect(tierACall).toBeTruthy();
      expect(tierACall).toMatch(/\/sc\s+onlogon/i);
      expect(tierACall).toContain(TASK_NAME);
      expect(tierACall).toContain('7777');
      expect(tierACall).toMatch(/\/RL\s+LIMITED/i);
      expect(tierACall?.toUpperCase()).not.toContain('/RU');
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

    it('returns { kind: "task" } when XML + Tier A fail but Tier B succeeds', async () => {
      // Fail /xml creates and no-/RU CLI creates; succeed the /RU form.
      execMock.mockImplementation((cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        const isCreate = cmd.toLowerCase().includes('/create');
        const isRu = cmd.toUpperCase().includes('/RU');
        if (isCreate && !isRu) cb(new Error('Access denied'), '', 'ERROR: Access is denied.');
        else cb(null, '', '');
      });

      const result = await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      expect(result).toEqual({ kind: 'task' });

      const cmds = execMock.mock.calls.map(c => c[0] as string);
      const tierBCall = cmds.find(
        c => c.toLowerCase().includes('/create') && c.toUpperCase().includes('/RU'),
      );
      expect(tierBCall).toBeTruthy();
      expect(tierBCall).toMatch(/\/IT/i);
    });

    it('does not write a Startup shortcut when Tier B succeeds', async () => {
      execMock.mockImplementation((cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        const isCreate = cmd.toLowerCase().includes('/create');
        const isRu = cmd.toUpperCase().includes('/RU');
        if (isCreate && !isRu) cb(new Error('Access denied'), '', 'ERROR: Access is denied.');
        else cb(null, '', '');
      });

      await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      const cmdWrites = fsMock.writeFileSync.mock.calls.filter(
        ([p]) => String(p).match(/\.cmd$/i),
      );
      expect(cmdWrites).toHaveLength(0);
    });
  });

  describe('install — Tier C (Startup shortcut fallback)', () => {
    beforeEach(() => {
      // Every schtasks /create form fails (XML and both CLI tiers).
      failMatching(/\/create/i);
    });

    it('returns { kind: "startup", path: <string> } when all tiers fail', async () => {
      const result = await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      expect(result.kind).toBe('startup');
      if (result.kind === 'startup') {
        expect(result.path).toMatch(/AstraMemoryD\.cmd$/i);
      }
    });

    it('writes a .cmd Startup shortcut containing the exec path and port', async () => {
      await adapter.install('node C:\\app\\dist\\cli\\index.js', 7777);
      const cmdWrite = fsMock.writeFileSync.mock.calls.find(
        ([p]) => String(p).match(/AstraMemoryD\.cmd$/i),
      );
      expect(cmdWrite).toBeTruthy();
      const content = cmdWrite![1] as string;
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

    // B3 review (2026-07-13): status() used to report `installed: false`
    // on ANY query failure, INCLUDING a timeout — for a task that could
    // have been genuinely installed and simply slow to answer. That is a
    // confident, wrong, actionable instruction ("Service: not installed.
    // Run 'astramem-local service install' to install.") produced by a
    // timeout (ADR-015 rule 4) — the worst instance in the sweep, since
    // the other two adapters at least kept `installed` correct. These pin
    // the fix.
    it('a timeout on the schtasks query reports inconclusive, NEVER a confident "not installed"', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        const err = Object.assign(new Error('Command failed: schtasks /query /tn "AstraMemoryD" /fo LIST\nETIMEDOUT'), {
          signal: 'SIGTERM',
          code: null,
        });
        cb(err, '', '');
      });
      fsMock.existsSync.mockReturnValue(false); // no startup-shortcut fallback either

      const s = await adapter.status();
      expect(s.inconclusive).toBe(true);
      // The pre-fix bug, pinned directly: must NEVER be a confident false.
      expect(s.installed).not.toBe(false);
    });

    it('schtasks binary missing (ENOENT) also reports inconclusive, never "not installed"', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        const err = Object.assign(new Error('spawn schtasks ENOENT'), { code: 'ENOENT', signal: null });
        cb(err, '', '');
      });
      fsMock.existsSync.mockReturnValue(false);

      const s = await adapter.status();
      expect(s.inconclusive).toBe(true);
    });

    it('a genuine "task not found" (schtasks completed, exit 1, no signal) is still reported as a real not-installed, not inconclusive', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        const err = Object.assign(new Error('ERROR: The system cannot find the file specified'), {
          code: 1,
          signal: null,
        });
        cb(err, '', 'ERROR: The system cannot find the file specified');
      });
      fsMock.existsSync.mockReturnValue(false);

      const s = await adapter.status();
      expect(s.inconclusive).toBeFalsy();
      expect(s.installed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // installWatchdogTimer() / uninstallWatchdogTimer() — issue #206
  // ---------------------------------------------------------------------------

  describe('installWatchdogTimer', () => {
    const WATCHDOG_TASK_NAME = 'AstraMemoryDWatchdog';

    it('registers a second scheduled task via /xml, separate from the daemon task', async () => {
      await adapter.installWatchdogTimer('node C:\\app\\dist\\cli\\index.js', 180);
      const cmds = execMock.mock.calls.map(c => c[0] as string);
      const createCall = cmds.find(
        c => c.toLowerCase().includes('schtasks') && c.toLowerCase().includes('/create'),
      );
      expect(createCall).toBeTruthy();
      expect(createCall).toMatch(/\/xml/i);
      expect(createCall).toContain(WATCHDOG_TASK_NAME);
      expect(createCall).not.toContain(TASK_NAME + '"'); // not the daemon task name
      expect(createCall).toMatch(/\/f/i);
    });

    it('writes XML with a repetition interval derived from intervalSec and the watchdog-probe command', async () => {
      await adapter.installWatchdogTimer('node C:\\app\\dist\\cli\\index.js', 180);
      const xmlWrite = fsMock.writeFileSync.mock.calls.find(
        ([p]) => String(p).match(/AstraMemoryDWatchdog\.xml$/i),
      );
      expect(xmlWrite).toBeTruthy();
      const buf = xmlWrite![1] as Buffer;
      const xml = buf.subarray(2).toString('utf16le');
      expect(xml).toContain('<Interval>PT180S</Interval>');
      expect(xml).toContain('service watchdog-probe');
      expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    });

    it('falls back to schtasks /sc MINUTE /mo N when the XML tier fails', async () => {
      execMock.mockImplementation((cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        if (/\/xml/i.test(cmd)) cb(new Error('Access denied'), '', 'ERROR: Access is denied.');
        else cb(null, '', '');
      });
      await adapter.installWatchdogTimer('node C:\\app\\dist\\cli\\index.js', 180);
      const cmds = execMock.mock.calls.map(c => c[0] as string);
      const fallbackCall = cmds.find(
        c => c.toLowerCase().includes('/create') && !c.toLowerCase().includes('/xml'),
      );
      expect(fallbackCall).toBeTruthy();
      expect(fallbackCall).toMatch(/\/sc\s+MINUTE/i);
      expect(fallbackCall).toMatch(/\/mo\s+3/i); // 180s -> 3 minutes
      expect(fallbackCall).toContain(WATCHDOG_TASK_NAME);
    });

    it('rounds sub-minute intervals up to at least 1 minute in the CLI fallback', async () => {
      execMock.mockImplementation((cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        if (/\/xml/i.test(cmd)) cb(new Error('Access denied'), '', 'ERROR: Access is denied.');
        else cb(null, '', '');
      });
      await adapter.installWatchdogTimer('node C:\\app\\dist\\cli\\index.js', 30);
      const cmds = execMock.mock.calls.map(c => c[0] as string);
      const fallbackCall = cmds.find(
        c => c.toLowerCase().includes('/create') && !c.toLowerCase().includes('/xml'),
      );
      expect(fallbackCall).toMatch(/\/mo\s+1/i);
    });
  });

  describe('uninstallWatchdogTimer', () => {
    const WATCHDOG_TASK_NAME = 'AstraMemoryDWatchdog';

    it('calls schtasks /delete /f for the watchdog task name', async () => {
      await adapter.uninstallWatchdogTimer();
      const cmds = execMock.mock.calls.map(c => c[0] as string);
      const deleteCall = cmds.find(
        c => c.toLowerCase().includes('schtasks') && c.toLowerCase().includes('/delete'),
      );
      expect(deleteCall).toBeTruthy();
      expect(deleteCall).toContain(WATCHDOG_TASK_NAME);
      expect(deleteCall).toMatch(/\/f/i);
    });

    it('does not throw when the watchdog task is absent (idempotent)', async () => {
      execMock.mockImplementation((_cmd: string, _opts: ExecOptions, cb: ExecCallback) => {
        cb(new Error('task not found'), '', 'The system cannot find the file specified');
      });
      await expect(adapter.uninstallWatchdogTimer()).resolves.toBeUndefined();
    });
  });
});
