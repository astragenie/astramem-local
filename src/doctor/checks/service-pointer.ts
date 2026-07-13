import { existsSync, readFileSync } from 'node:fs';
import type { Check, CheckResult } from '../types.js';
import { shimPaths, type ShimPointer } from '../../service/shim.js';
import { releaseIdFromEntryJs } from '../../service/release.js';

// ─── Check: Service pointer — release-pinned vs dev-pinned (FEAT-438 SLICE-418 AC-4) ──

/**
 * Warns loudly when the service pointer (current.json) is `--dev`-pinned
 * (src/cli/reinstall.ts's `reinstallDev`) — i.e. serving the mutable
 * checkout's `dist/` rather than an immutable release dir. That is exactly
 * the footgun FEAT-438 exists to close (the 2026-07-07 stale-dist outage),
 * so a doctor run should never let it go unnoticed. Cross-platform since
 * FEAT-443 SLICE-1 — current.json indirection now exists on linux/darwin too
 * (see shim.ts / install-flow.ts, which write the stable shim unconditionally
 * on every platform), so this check no longer gates on `platform() === 'win32'`.
 */
export function checkServicePointer(pointerPathOverride?: string, releasesRootOverride?: string): Check {
  return {
    name: 'Service pointer',
    async run(): Promise<CheckResult> {
      const pointerPath = pointerPathOverride ?? shimPaths().pointerPath;
      if (!existsSync(pointerPath)) {
        return { ok: true, message: 'Service pointer: not installed yet (no current.json)' };
      }

      let pointer: ShimPointer;
      try {
        pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as ShimPointer;
      } catch (err) {
        return {
          ok: false,
          message: `Service pointer: current.json unreadable: ${err}`,
          fix: 'astramem-local reinstall',
        };
      }

      if (pointer.devPinned) {
        return {
          ok: false,
          message: "service is DEV-PINNED to the checkout dist/ (not a release) — run 'reinstall' to re-pin",
          fix: 'astramem-local reinstall',
        };
      }

      // devPinned is NOT set — but that alone does not mean release-pinned.
      // A fresh `init` / `service install` (install-flow.ts with no
      // entryJsOverride) points current.json straight at the checkout's
      // dist/ WITHOUT ever setting devPinned (only reinstallDev does that).
      // Only trust "release-pinned" when entryJs actually resolves to a
      // real release id under releasesRoot.
      const id = releaseIdFromEntryJs(pointer.entryJs, releasesRootOverride);
      if (id) {
        return { ok: true, message: `service is release-pinned: ${id}` };
      }
      return {
        ok: false,
        message: `service pointer is not release-pinned (entry: ${pointer.entryJs}) — run 'reinstall' to pin a release`,
        fix: 'astramem-local reinstall',
      };
    },
  };
}
