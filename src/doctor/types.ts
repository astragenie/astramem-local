export interface CheckResult {
  ok: boolean;
  message: string;
  /** Optional shell command / instruction to fix the issue */
  fix?: string;
}

export interface Check {
  /** Short unique identifier used in output table and JSON */
  name: string;
  /** Execute the check and return a result */
  run(): Promise<CheckResult>;
}
