/**
 * FEAT-458 S2-AC-5: slice 2 is the capture-free proxy slice — its diff must
 * contain zero capture code paths (no tee, no relevance-gate call, no spool
 * write of any kind). This is a structural check, not a behavioral one: walk
 * every file transitively imported (relative imports only — this repo's own
 * modules) starting from the proxy's entry points, and assert none of them
 * import anything under src/capture, src/ingest, or src/distill.
 *
 * A false negative here (missing a capture import) would be a real S2-AC-5
 * violation; a false positive (flagging an innocuous import) fails loud and
 * is easy to re-scope — this deliberately errs toward being strict.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ENTRY_POINTS = ['src/cli/proxy.ts', 'src/proxy/server.ts'];
const FORBIDDEN_SEGMENTS = ['/capture/', '/ingest/', '/distill/'];

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?from\s+)?['"](\.\.?\/[^'"]+)['"]/g;

function resolveImport(fromFile: string, spec: string): string | null {
  const rawBase = resolve(dirname(fromFile), spec);
  // This repo's source imports use explicit '.js' extensions (ESM-style,
  // resolved by tsc against the '.ts' source) — strip it before trying '.ts'
  // candidates, or a spec like '../server/lib/network.js' would wrongly
  // resolve to a literal 'network.js.ts' path.
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

/** `abs` is always an already-resolved absolute path (from `resolveImport` or
 *  an initial entry point) — no repeated repo-relative round-tripping. */
function collectImportGraph(abs: string, seen: Set<string>): void {
  if (seen.has(abs)) return;
  seen.add(abs);

  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return; // non-existent resolved candidate — ignore
  }

  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1];
    if (!spec) continue;
    const resolved = resolveImport(abs, spec);
    if (resolved) collectImportGraph(resolved, seen);
  }
}

describe('FEAT-458 S2-AC-5: zero capture code paths in the proxy import graph', () => {
  it('src/cli/proxy.ts and src/proxy/server.ts never (transitively) import src/capture, src/ingest, or src/distill', () => {
    const allFiles = new Set<string>();
    for (const entry of ENTRY_POINTS) {
      collectImportGraph(resolve(REPO_ROOT, entry), allFiles);
    }

    expect(allFiles.size).toBeGreaterThan(1); // sanity: the graph actually walked something

    const offenders = [...allFiles].filter((f) => {
      const normalized = f.replace(/\\/g, '/');
      return FORBIDDEN_SEGMENTS.some((seg) => normalized.includes(seg));
    });

    expect(offenders).toEqual([]);
  });
});
