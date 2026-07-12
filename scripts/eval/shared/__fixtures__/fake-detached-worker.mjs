#!/usr/bin/env node
/**
 * Fake detached worker (FEAT-462 slice B, AC-2 detach test; also used by
 * daemon-manifest.test.ts's PID-reuse-guard identity-check tests, review
 * fix Finding 1). Plain Node, no build step. Writes its own PID once, then
 * a heartbeat file every 100ms until killed — stands in for "the
 * orchestrator + shard daemons keep running after the invoking
 * terminal/session exits" without needing a test to literally kill its own
 * process to prove it.
 *
 * Optional `--port <n>`: also binds a real TCP listener on 127.0.0.1:<n> so
 * tests can exercise `checkPortOwner`'s real `netstat`/`lsof` identity
 * check against an actual listening socket, not just a bare process.
 *
 * Args: --pid-file <path> --heartbeat-file <path> [--port <n>]
 */
import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer } from 'node:net';

const args = process.argv.slice(2);
function get(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const pidFile = get('--pid-file');
const heartbeatFile = get('--heartbeat-file');
const port = get('--port');
if (!pidFile || !heartbeatFile) {
  console.error('fake-detached-worker: --pid-file and --heartbeat-file are required');
  process.exit(1);
}

mkdirSync(dirname(pidFile), { recursive: true });
mkdirSync(dirname(heartbeatFile), { recursive: true });
writeFileSync(pidFile, String(process.pid), 'utf8');

function startHeartbeat() {
  let tick = 0;
  setInterval(() => {
    tick++;
    // Atomic tmp+rename (same technique as src/config/writer.ts's
    // writeConfig, and this slice's own run-status.ts/daemon-manifest.ts) --
    // a plain writeFileSync truncates-then-writes, so a SIGKILL landing
    // mid-write would permanently corrupt the file (the killed process
    // never gets to finish it). Tests that kill this fixture and then read
    // the heartbeat file afterward depend on the LAST successful write
    // always being intact.
    const tmpPath = `${heartbeatFile}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, tick, ts: Date.now() }), 'utf8');
    renameSync(tmpPath, heartbeatFile);
  }, 100);
}

if (port) {
  const server = createServer();
  server.on('error', err => {
    console.error(`fake-detached-worker: failed to bind port ${port}: ${err.message}`);
    process.exit(1);
  });
  // Heartbeat only starts once the port is CONFIRMED bound (the listen
  // callback), not merely requested -- otherwise a test that treats "a
  // heartbeat exists" as proof the port is live (e.g. before calling
  // checkPortOwner's netstat check) has a real race: server.listen() is
  // async, and under load the bind can lag behind the interval timer
  // firing for the first time.
  server.listen(Number(port), '127.0.0.1', startHeartbeat);
} else {
  startHeartbeat();
}
