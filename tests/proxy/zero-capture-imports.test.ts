/**
 * FEAT-458 S2-AC-5 established the original invariant: the proxy relay's
 * import graph contains zero capture code paths. FEAT-458 S3 (the capture
 * fork) necessarily changes that premise for the CLI wiring (src/cli/
 * proxy.ts now imports src/capture/proxy.ts to construct the optional tee)
 * — so this file no longer asserts "the whole proxy subsystem never touches
 * capture." What it asserts instead, per the team-lead's guidance, is the
 * successor invariant that actually matters for ADR-013's safety property:
 *
 *   1. The RELAY ITSELF (src/proxy/server.ts) stays capture-blind — zero
 *      capture/ingest/distill imports in ITS transitive graph, independent
 *      of whatever the CLI layer wires on top of it. This is what makes the
 *      byte-transparent forward path structurally incapable of depending on
 *      capture internals, matching S2-AC-5's original spirit exactly.
 *   2. The dependency arrow between the relay and the capture fork points
 *      ONE way only: src/capture/proxy.ts (the fork) may import types from
 *      src/proxy/server.ts (the relay), but src/proxy/server.ts must never
 *      import anything from src/capture/proxy.ts — checked directly rather
 *      than inferred, so a future edit that adds the reverse import fails
 *      loud here instead of silently creating a cycle.
 *
 * Same import-graph-walk approach as the original file: relative imports
 * only, this repo's own modules, a false positive fails loud and is easy to
 * re-scope.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FORBIDDEN_SEGMENTS = ['/capture/', '/ingest/', '/distill/'];

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?from\s+)?['"](\.\.?\/[^'"]+)['"]/g;

function resolveImport(fromFile: string, spec: string): string | null {
  const rawBase = resolve(dirname(fromFile), spec);
  const base = rawBase.endsWith('.js') ? rawBase.slice(0, -3) : rawBase;
  const candidates = [`${base}.ts`, base, join(base, 'index.ts')];
  for (const c of candidates) {
    try {
      readFileSync(c, 'utf8');
      return c;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function collectImportGraph(abs: string, seen: Set<string>): void {
  if (seen.has(abs)) return;
  seen.add(abs);

  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return;
  }

  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (!spec) continue;
    const resolved = resolveImport(abs, spec);
    if (resolved) collectImportGraph(resolved, seen);
  }
}

describe('FEAT-458 S3: relay stays capture-blind, dependency arrow points one way', () => {
  it('src/proxy/server.ts (the relay, alone) never (transitively) imports src/capture, src/ingest, or src/distill', () => {
    const allFiles = new Set<string>();
    collectImportGraph(resolve(REPO_ROOT, 'src/proxy/server.ts'), allFiles);

    // Sanity: the walk executed (found at least the entry file itself). Not
    // `toBeGreaterThan(1)` — FEAT-458 S3 removed server.ts's last relative
    // import (the dead `assertLoopbackBind`'s `isLoopbackHost` import, see
    // S2-review dead-code finding), so this file now has ZERO repo-relative
    // imports of its own; the graph is just {server.ts}. That is itself a
    // (trivial, stronger) confirmation of the invariant below, not a broken
    // walk.
    expect(allFiles.size).toBeGreaterThanOrEqual(1);

    const offenders = [...allFiles].filter((f) => {
      const normalized = f.replace(/\\/g, '/');
      return FORBIDDEN_SEGMENTS.some((seg) => normalized.includes(seg));
    });

    expect(offenders).toEqual([]);
  });

  it('src/capture/proxy.ts (the fork) depends on the relay, never the reverse', () => {
    const forkGraph = new Set<string>();
    collectImportGraph(resolve(REPO_ROOT, 'src/capture/proxy.ts'), forkGraph);

    // The fork legitimately imports the relay (for ProxyTeeSink's type) —
    // this is the expected, one-way direction.
    const normalizedForkGraph = [...forkGraph].map((f) => f.replace(/\\/g, '/'));
    expect(normalizedForkGraph.some((f) => f.endsWith('src/proxy/server.ts'))).toBe(true);

    // The relay's OWN graph (computed independently, starting only from
    // server.ts) must never contain the fork — if it did, that would be a
    // cycle (the fork depending on the relay AND the relay depending back on
    // the fork), which is exactly the wrong-direction coupling ADR-013 rules
    // out ("the capture module depends on the relay, not vice-versa").
    const relayGraph = new Set<string>();
    collectImportGraph(resolve(REPO_ROOT, 'src/proxy/server.ts'), relayGraph);
    const normalizedRelayGraph = [...relayGraph].map((f) => f.replace(/\\/g, '/'));
    expect(normalizedRelayGraph.some((f) => f.endsWith('src/capture/proxy.ts'))).toBe(false);
  });

  it('src/cli/proxy.ts MAY reach the capture fork (expected — it wires the optional tee) — recorded here so a future removal is a deliberate, visible test change, not a silent regression either way', () => {
    const cliGraph = new Set<string>();
    collectImportGraph(resolve(REPO_ROOT, 'src/cli/proxy.ts'), cliGraph);
    const normalizedCliGraph = [...cliGraph].map((f) => f.replace(/\\/g, '/'));
    expect(normalizedCliGraph.some((f) => f.endsWith('src/capture/proxy.ts'))).toBe(true);
  });
});
