export interface CheckResult {
  ok: boolean;
  message: string;
  /** Optional shell command / instruction to fix the issue */
  fix?: string;
  /**
   * True when the check itself could not run (its own query/probe threw)
   * rather than having run and found the underlying metric healthy. Doctor's
   * `ok: true` / ✓ path is reserved for "verified healthy" — a check that
   * never got to verify anything must not render identically to one that
   * did, or a real failure (schema drift, a broken metric query, a corrupt
   * row) looks exactly like a clean bill of health. Deliberately does NOT
   * flip `ok` (preserves the existing "don't hard-fail doctor's exit code
   * over a transient read error" behavior) — it only changes how the result
   * is rendered and counted, so `formatTable`/`formatJson` can tell an
   * operator "unverified" apart from "verified fine" without doctor gaining
   * a new failure mode of its own.
   */
  inconclusive?: boolean;
  /**
   * Optional structured numbers backing the message (2026-08-05 forensics
   * follow-up): the event-loop-lag check computes p99/mean/max every
   * scheduled run and then threw them away — only the check NAME survived
   * into healthState.doctor, so reconstructing a stall timeline meant
   * regex-mining log messages. Checks that measure something put the raw
   * numbers here so the schedule handler can persist/surface them without
   * parsing prose. Renderers ignore it.
   */
  data?: Record<string, number>;
}

export interface Check {
  /** Short unique identifier used in output table and JSON */
  name: string;
  /**
   * Cost tier — REQUIRED so a check's cost classification is a compile-time
   * decision, not an assumption inferred from which opts happen to be
   * passed. #226 (2026-07-13) put two genuinely O(N) full-table-scan checks
   * (checkMemoryHealth, checkEntityNameQuality) on a 15-minute unattended
   * schedule because "frequent tier" was defined negatively — "whatever
   * isn't gated behind llmProviders/embedProvider" — rather than by an
   * explicit property each check declares. See src/doctor/schedule.ts's
   * runFrequentDoctorChecks, which now selects `tier === 'cheap'` instead of
   * inferring the frequent set from opts shape.
   *
   * - 'cheap': index-backed/bounded SQLite reads, filesystem stats, or a
   *   loopback-only HTTP probe. Safe on a 15-minute interval, forever, on
   *   any corpus size.
   * - 'full': an unbounded/unindexed scan of a corpus-scale table
   *   (memories, memory_events, entities, entity_relations — tables that
   *   grow with usage rather than staying bounded by time or migration
   *   count), per-row JS-side processing over such a scan, or a real
   *   network/LLM/embed call. Reserved for the operator-invoked `doctor`
   *   CLI and the existing >=24h piggyback tick (see schedule.ts's module
   *   doc comment) — never the frequent schedule.
   *
   * A check author who forgets this field gets a TypeScript compile error,
   * not a silent default into the frequent tier.
   */
  tier: 'cheap' | 'full';
  /** Execute the check and return a result */
  run(): Promise<CheckResult>;
}
