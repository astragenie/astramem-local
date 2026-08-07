/**
 * FEAT-476 Phase 0 — the AC-7 attribution-join fallback: match a
 * `cost_events.captured_at` timestamp against
 * `.claude/state/crew/workflow-state.json`'s `currentRun`/`recentRuns`
 * windows.
 *
 * This is the fallback path for BOTH ingest sources in Phase 0, not just
 * proxy rows. The FEAT-476 spec frames `cost_events.session_key` as the
 * PRIMARY attribution key — a real `session.id` for OTel rows should, in
 * principle, resolve directly to a slice. But no session-id-to-slice index
 * exists anywhere in this repo today (`workflow-state.json` records time
 * windows + titles, never a session id), so there is nothing for an OTel
 * row's real session_key to join against yet. Until that index exists,
 * every row — proxy or OTel — resolves through the SAME time-window join
 * this module implements. Documented here rather than silently pretending
 * OTel rows get a better answer than they actually do in Phase 0.
 *
 * Deliberately a REPORT-TIME join, not a value cached onto `cost_events` at
 * ingest — see cost-events.ts's `CostEventInput` doc comment for why: a
 * `workflow-state.json` window rotates out of `recentRuns` eventually, so
 * baking the join result in at ingest time would silently go stale. The
 * tradeoff this accepts: a `cost_events` row captured long enough ago that
 * its window has rotated out of `workflow-state.json` entirely resolves to
 * `unattributed` on a LATER report run, even though a report run shortly
 * after capture might have resolved it to a real slice. This is the same
 * "proxy-path attribution is inherently second-class" tradeoff the FEAT-476
 * spec's own risk notes call out — not a bug to silently fix here.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkflowStateWindow {
  /** Best-effort slice identifier extracted from the run's `title` (see
   *  `extractSliceId`) — falls back to the raw title when no `SLICE-NNN`
   *  pattern is found, so a window is never silently unusable just because
   *  its title doesn't match the expected shape. */
  sliceId: string;
  startedAtMs: number;
  /** `null` means "still open" — treated as extending to `nowMs` at query
   *  time (the live `currentRun` window, or a `recentRuns` entry that was
   *  never marked `completedAt` for some reason). */
  endedAtMs: number | null;
}

const SLICE_ID_RE = /SLICE-?(\d+)/i;

/** Extract a normalized `SLICE-NNN` id from a workflow-state run title
 *  (e.g. "FEAT548 SLICE441: Implement FEAT-548" -> "SLICE-441"). Falls back
 *  to the raw title verbatim when the pattern isn't found — an unparseable
 *  title still identifies SOME real unit of work, which is more useful than
 *  discarding the window entirely. */
function extractSliceId(title: string): string {
  const match = SLICE_ID_RE.exec(title);
  return match ? `SLICE-${match[1]}` : title;
}

interface RawRun {
  title?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
}

function parseRun(raw: unknown): WorkflowStateWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const run = raw as RawRun;
  if (typeof run.title !== 'string' || typeof run.startedAt !== 'string') return null;
  const startedAtMs = Date.parse(run.startedAt);
  if (Number.isNaN(startedAtMs)) return null;
  const endedAtMs = typeof run.completedAt === 'string' ? Date.parse(run.completedAt) : null;
  return {
    sliceId: extractSliceId(run.title),
    startedAtMs,
    endedAtMs: endedAtMs !== null && !Number.isNaN(endedAtMs) ? endedAtMs : null,
  };
}

/**
 * Read + parse `.claude/state/crew/workflow-state.json` under `repoRoot`
 * (defaults to `process.cwd()`) into a flat list of windows (`currentRun` +
 * every `recentRuns` entry). Tolerant of a missing or malformed file —
 * returns an empty array rather than throwing, matching this module's own
 * "never guess, but never crash a report over missing operator state"
 * posture; a report over zero windows just buckets every row
 * `unattributed`, which is an honest answer, not a silent failure.
 */
export function readWorkflowStateWindows(repoRoot: string = process.cwd()): WorkflowStateWindow[] {
  const path = join(repoRoot, '.claude', 'state', 'crew', 'workflow-state.json');
  if (!existsSync(path)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];

  const windows: WorkflowStateWindow[] = [];
  const obj = parsed as { currentRun?: unknown; recentRuns?: unknown };
  const current = parseRun(obj.currentRun);
  if (current) windows.push(current);
  if (Array.isArray(obj.recentRuns)) {
    for (const raw of obj.recentRuns) {
      const w = parseRun(raw);
      if (w) windows.push(w);
    }
  }
  return windows;
}

export type SliceAttributionBucket = 'slice' | 'unattributed' | 'ambiguous';

export interface SliceAttribution {
  bucket: SliceAttributionBucket;
  /** Populated only when bucket === 'slice'. */
  sliceId: string | null;
  /** Populated only when bucket === 'ambiguous' — the N in "ambiguous (N
   *  candidates)" (AC-7). */
  candidates: number | null;
}

/**
 * AC-7: attribute `atMs` against `windows`.
 *   - Exactly one window contains it -> `{ bucket: 'slice', sliceId }`.
 *   - Zero windows contain it -> `{ bucket: 'unattributed' }`.
 *   - More than one window contains it (concurrent worktrees — "confirmed
 *     the normal case in this repo", per the FEAT-476 spec) ->
 *     `{ bucket: 'ambiguous', candidates: N }`. Never guesses which one.
 *
 * An open window (`endedAtMs === null`) is treated as extending to `nowMs`
 * — the live `currentRun` (or a `recentRuns` entry stuck open) still
 * plausibly contains `atMs` if it started before it and hasn't ended yet.
 */
export function attributeSlice(windows: WorkflowStateWindow[], atMs: number, nowMs: number = Date.now()): SliceAttribution {
  const matches = windows.filter(w => {
    const end = w.endedAtMs ?? nowMs;
    return w.startedAtMs <= atMs && atMs <= end;
  });

  if (matches.length === 0) return { bucket: 'unattributed', sliceId: null, candidates: null };
  if (matches.length === 1) return { bucket: 'slice', sliceId: matches[0]!.sliceId, candidates: null };
  return { bucket: 'ambiguous', sliceId: null, candidates: matches.length };
}
