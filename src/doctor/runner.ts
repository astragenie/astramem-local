import type { Check, CheckResult } from './types.js';

export interface CheckResultWithName extends CheckResult {
  name: string;
}

/**
 * Run all checks, catching any unexpected errors and surfacing them as failures.
 */
export async function runChecks(checks: Check[]): Promise<CheckResultWithName[]> {
  const results: CheckResultWithName[] = [];
  for (const check of checks) {
    try {
      const result = await check.run();
      results.push({ name: check.name, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name: check.name, ok: false, message: `Error: ${message}` });
    }
  }
  return results;
}

/**
 * Format results as a human-readable table for terminal output.
 */
export function formatTable(results: CheckResultWithName[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    lines.push(`  ${icon} ${r.name}: ${r.message}`);
    if (!r.ok && r.fix) {
      lines.push(`      fix: ${r.fix}`);
    }
  }
  return lines.join('\n');
}

/**
 * Format results as machine-readable JSON.
 * Shape: { checks: [{name, ok, message, fix?}], summary: {ok: N, fail: M} }
 */
export function formatJson(results: CheckResultWithName[]): string {
  const checks = results.map(r => {
    const entry: Record<string, unknown> = {
      name: r.name,
      ok: r.ok,
      message: r.message,
    };
    if (r.fix !== undefined) entry.fix = r.fix;
    return entry;
  });
  const summary = {
    ok: results.filter(r => r.ok).length,
    fail: results.filter(r => !r.ok).length,
  };
  return JSON.stringify({ checks, summary }, null, 2);
}
