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
import { writeFileSync, mkdirSync } from 'node:fs';
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

if (port) {
  const server = createServer();
  server.listen(Number(port), '127.0.0.1');
}

let tick = 0;
setInterval(() => {
  tick++;
  writeFileSync(heartbeatFile, JSON.stringify({ pid: process.pid, tick, ts: Date.now() }), 'utf8');
}, 100);
