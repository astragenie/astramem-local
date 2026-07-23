/**
 * Shared call-count + wall-clock cap tracker (docs/specs/20260723-codebase-refactor-plan.md §1a).
 *
 * Reconciles the byte-identical `GatekeeperRunTracker` (src/distill/gatekeeper.ts),
 * `AtomTriageRunTracker` (src/distill/atom-triage.ts), and `DupJudgeRunTracker`
 * (src/consolidate/dup-judge.ts) — same fields, same shouldStop/recordCall/state
 * shape, same fail-open contract (a tripped cap means the caller's remaining
 * un-processed items fall through un-gated/un-triaged/un-judged, never an
 * auto-resolve-by-timeout — the FEAT-482 lesson each of the three classes
 * used to restate independently). The only per-site variance was the log
 * message: a bracketed tag plus two prose fragments naming what's being
 * skipped and what happens to the fallthrough items. `RunCapMessages` carries
 * that variance; everything else lives here once.
 *
 * Deliberately excludes `DistillCostCapTracker` (src/distill/cost-cap.ts —
 * has an extra `enabled` toggle and a different contract), the
 * contradiction-judge inline tracker (src/consolidate/consolidate.ts), and
 * `groundAtomDates`'s inline loop (src/distill/ground-dates.ts) — none of
 * those share this exact shape.
 */
export interface RunCap {
  maxPerRun: number;
  maxWallClockMs: number;
}

export interface RunCapMessages {
  /** Bracketed log tag, e.g. `'gatekeeper'` -> `[gatekeeper] ...`. */
  tag: string;
  /** What further calls are being skipped, e.g. `'further gate calls for this job'`. */
  skipping: string;
  /** What happens to the un-processed remainder — a full sentence, own trailing period. */
  fallthrough: string;
}

export class RunCapTracker {
  private callsThisRun = 0;
  private readonly startedAt = Date.now();
  private capReached = false;
  private wallClockCapReached = false;
  private loggedTrip = false;

  constructor(
    private readonly caps: RunCap,
    private readonly messages: RunCapMessages,
    private readonly log: (message: string) => void = (m) => console.warn(m),
  ) {}

  shouldStop(): boolean {
    if (this.callsThisRun >= this.caps.maxPerRun) {
      this.capReached = true;
      this.logTripOnce('call-count', `${this.callsThisRun}/${this.caps.maxPerRun} calls`);
      return true;
    }
    const elapsed = Date.now() - this.startedAt;
    if (elapsed >= this.caps.maxWallClockMs) {
      this.wallClockCapReached = true;
      this.logTripOnce('wall-clock', `${elapsed}ms/${this.caps.maxWallClockMs}ms`);
      return true;
    }
    return false;
  }

  recordCall(): void {
    this.callsThisRun++;
  }

  state(): { callsExecuted: number; capReached: boolean; wallClockCapReached: boolean } {
    return {
      callsExecuted: this.callsThisRun,
      capReached: this.capReached,
      wallClockCapReached: this.wallClockCapReached,
    };
  }

  private logTripOnce(kind: 'call-count' | 'wall-clock', detail: string): void {
    if (this.loggedTrip) return;
    this.loggedTrip = true;
    this.log(
      `[${this.messages.tag}] ${kind} cap reached (${detail}) — skipping ${this.messages.skipping}; ` +
      `${this.messages.fallthrough}`,
    );
  }
}
