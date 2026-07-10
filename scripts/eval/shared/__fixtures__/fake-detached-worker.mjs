#!/usr/bin/env node
/**
 * Fake detached worker (FEAT-462 slice B, AC-2 detach test). Plain Node, no
 * build step. Writes its own PID once, then a heartbeat file every 100ms
 * until killed — stands in for "the orchestrator + shard daemons keep
 * running after the invoking terminal/session exits" without needing a
 * test to literally kill its own process to prove it.
 *
 * Args: --pid-file <path> --heartbeat-file <path>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
function get(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const pidFile = get('--pid-file');
const heartbeatFile = get('--heartbeat-file');
if (!pidFile || !heartbeatFile) {
  console.error('fake-detached-worker: --pid-file and --heartbeat-file are required');
  process.exit(1);
}

mkdirSync(dirname(pidFile), { recursive: true });
mkdirSync(dirname(heartbeatFile), { recursive: true });
writeFileSync(pidFile, String(process.pid), 'utf8');

let tick = 0;
setInterval(() => {
  tick++;
  writeFileSync(heartbeatFile, JSON.stringify({ pid: process.pid, tick, ts: Date.now() }), 'utf8');
}, 100);
