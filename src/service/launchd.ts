import { exec } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ServiceAdapter, ServiceStatus, InstallResult } from './types.js';

const LABEL = 'com.astragenie.astra-memoryd';
const PLIST_FILENAME = `${LABEL}.plist`;
const BACKUP_LABEL = 'com.astragenie.astra-memoryd-backup';
const BACKUP_PLIST_FILENAME = `${BACKUP_LABEL}.plist`;

function agentsDir(): string {
  return join(homedir(), 'Library', 'LaunchAgents');
}

function plistPath(): string {
  return join(agentsDir(), PLIST_FILENAME);
}

function backupPlistPath(): string {
  return join(agentsDir(), BACKUP_PLIST_FILENAME);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildBackupPlist(args: string[], keep: number): string {
  const argItems = args.map(a => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${BACKUP_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${argItems}
    <string>backup</string>
    <string>--keep</string>
    <string>${keep}</string>
  </array>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>${homedir()}/Library/Logs/astra-memoryd-backup.out.log</string>
  <key>StandardErrorPath</key>
  <string>${homedir()}/Library/Logs/astra-memoryd-backup.err.log</string>
</dict>
</plist>
`;
}

function buildPlist(args: string[], port: number): string {
  const argItems = args.map(a => `    <string>${xmlEscape(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${argItems}
    <string>serve</string>
    <string>--port</string>
    <string>${port}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>${homedir()}/Library/Logs/astra-memoryd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${homedir()}/Library/Logs/astra-memoryd.err.log</string>
</dict>
</plist>
`;
}

function runCmd(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`Command failed: ${cmd}\n${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

/** Best-effort launchctl load/bootstrap for current macOS version. */
async function launchctlLoad(path: string): Promise<void> {
  // macOS 10.15+ prefers bootstrap gui/$UID; older supports load
  const uid = process.getuid?.() ?? '';
  try {
    await runCmd(`launchctl bootstrap gui/${uid} "${path}"`);
  } catch {
    await runCmd(`launchctl load -w "${path}"`);
  }
}

async function launchctlUnload(path: string): Promise<void> {
  const uid = process.getuid?.() ?? '';
  try {
    await runCmd(`launchctl bootout gui/${uid} "${path}"`);
  } catch {
    await runCmd(`launchctl unload -w "${path}"`);
  }
}

export class LaunchdAdapter implements ServiceAdapter {
  readonly platform = 'darwin' as const;

  async install(execPath: string, port: number): Promise<InstallResult> {
    mkdirSync(agentsDir(), { recursive: true });
    // execPath formatted by resolveCliExecPath() as: "<nodeBin>" "<indexJs>"
    // Parse double-quoted tokens so paths with spaces (e.g. /Users/Jane Smith/...)
    // survive intact. Unquoted execPath falls back to whitespace split.
    const args = Array.from(execPath.matchAll(/"([^"]+)"|(\S+)/g))
      .map(m => m[1] ?? m[2] ?? '')
      .filter(a => a.length > 0);
    writeFileSync(plistPath(), buildPlist(args, port), 'utf8');
    await launchctlLoad(plistPath());
    return { kind: 'task' };
  }

  async uninstall(): Promise<void> {
    if (existsSync(plistPath())) {
      try { await launchctlUnload(plistPath()); } catch { /* ignore if not loaded */ }
      unlinkSync(plistPath());
    }
  }

  async start(): Promise<void> {
    const uid = process.getuid?.() ?? '';
    try {
      await runCmd(`launchctl kickstart -k gui/${uid}/${LABEL}`);
    } catch {
      await runCmd(`launchctl start ${LABEL}`);
    }
  }

  async stop(): Promise<void> {
    const uid = process.getuid?.() ?? '';
    try {
      await runCmd(`launchctl kill TERM gui/${uid}/${LABEL}`);
    } catch {
      await runCmd(`launchctl stop ${LABEL}`);
    }
  }

  async status(): Promise<ServiceStatus> {
    const installed = existsSync(plistPath());
    if (!installed) return { installed: false, running: false };

    try {
      const out = await runCmd(`launchctl list ${LABEL}`);
      const running = out.includes('"PID"') || /\bPID\b.*=\s*[0-9]+/.test(out) || out.includes('running = 1');
      return { installed, running, detail: out };
    } catch {
      return { installed, running: false, detail: 'not loaded' };
    }
  }

  async installBackupTimer(execPath: string, keep: number): Promise<void> {
    mkdirSync(agentsDir(), { recursive: true });
    const args = Array.from(execPath.matchAll(/"([^"]+)"|(\S+)/g))
      .map(m => m[1] ?? m[2] ?? '')
      .filter(a => a.length > 0);
    writeFileSync(backupPlistPath(), buildBackupPlist(args, keep), 'utf8');
    await launchctlLoad(backupPlistPath());
  }

  async uninstallBackupTimer(): Promise<void> {
    const bp = backupPlistPath();
    if (existsSync(bp)) {
      try { await launchctlUnload(bp); } catch { /* ignore if not loaded */ }
      unlinkSync(bp);
    }
  }
}
