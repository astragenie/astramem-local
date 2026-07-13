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
}

export interface Check {
  /** Short unique identifier used in output table and JSON */
  name: string;
  /** Execute the check and return a result */
  run(): Promise<CheckResult>;
}
