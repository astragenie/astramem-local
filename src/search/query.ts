/**
 * Query string parser for AstraMemory search.
 *
 * Parses structured filter tokens from a query string:
 *   type:decision    → filters.type = ['decision']
 *   repo:my-repo     → filters.repo = 'my-repo'
 *   project:wave2    → filters.project = 'wave2'
 *   since:7d         → filters.since = epoch ms 7 days ago
 *   since:24h        → filters.since = epoch ms 24 hours ago
 *   since:Nh         → filters.since = epoch ms N hours ago
 *
 * Unknown prefixes are left in the bare query text (not applied as filters).
 * Design choice: unknown filters are silently ignored (not rejected as 400)
 * because the CLI passes arbitrary user text and we prefer forgiving parse.
 */

export interface ParsedQuery {
  /** Bare search terms with filter tokens removed */
  q: string;
  /** Extracted structured filters */
  filters: {
    type?: string[];
    repo?: string;
    project?: string;
    /** Epoch ms lower bound for created_at */
    since?: number;
  };
}

const KNOWN_FILTERS = new Set(['type', 'repo', 'project', 'since']);

/**
 * Parse a duration string like "7d" or "24h" into milliseconds.
 * Returns null if format is unrecognized.
 */
function parseDuration(value: string): number | null {
  const dMatch = value.match(/^(\d+)d$/);
  if (dMatch) return Number(dMatch[1]) * 24 * 60 * 60 * 1000;
  const hMatch = value.match(/^(\d+)h$/);
  if (hMatch) return Number(hMatch[1]) * 60 * 60 * 1000;
  return null;
}

export function parseQuery(raw: string): ParsedQuery {
  const filters: ParsedQuery['filters'] = {};
  const bareTerms: string[] = [];

  const tokens = raw.trim().split(/\s+/);

  for (const token of tokens) {
    if (!token) continue;
    const colonIdx = token.indexOf(':');
    if (colonIdx > 0) {
      const key = token.slice(0, colonIdx);
      const val = token.slice(colonIdx + 1);
      if (KNOWN_FILTERS.has(key) && val) {
        switch (key) {
          case 'type':
            filters.type = filters.type ? [...filters.type, val] : [val];
            break;
          case 'repo':
            filters.repo = val;
            break;
          case 'project':
            filters.project = val;
            break;
          case 'since': {
            const durationMs = parseDuration(val);
            if (durationMs !== null) {
              filters.since = Date.now() - durationMs;
            }
            // If format is unrecognized, drop silently (treat as ignored)
            break;
          }
        }
        // Known filter processed — do not include in bare query
        continue;
      }
    }
    // Unknown token (no colon, or unknown prefix) → include in bare query
    bareTerms.push(token);
  }

  return { q: bareTerms.join(' '), filters };
}
