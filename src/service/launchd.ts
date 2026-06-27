import { exec } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ServiceAdapter, ServiceStatus } from './types.js';

const LABEL = 'com.astragenie.astra-memoryd';
const PLIST_FILENAME = `${LABEL}.plist`;

function agentsDir(): string {
  return join(homedir(), 'Library', 'LaunchAgents');
}

function plistPath(): string {
  return join(agentsDir(), PLIST_FILENAME);
}

function buildPlist(args: string[], port: number): string {
  const argItems = args.map(a => `    <string>${a}</string>`).join('\n');
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

  async install(execPath: string, port: number): Promise<void> {
    mkdirSync(agentsDir(), { recursive: true });
    // execPath may be "node /path/to/dist/cli/index.js" — split into args
    const args = execPath.split(' ');
    writeFileSync(plistPath(), buildPlist(args, port), 'utf8');
    await launchctlLoad(plistPath());
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
}
