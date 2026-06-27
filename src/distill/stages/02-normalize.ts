/**
 * Stage 2 — Normalize (deterministic)
 *
 * - Windows backslash paths → forward slash
 * - Absolute paths → home-relative (~/)
 * - ISO-8601 timestamp normalization (various formats → canonical)
 * - Agent name casing → lowercase canonical
 */

import { homedir } from 'node:os';

/**
 * Canonical agent name mapping. Keys are lowercase patterns to match,
 * values are canonical forms.
 */
const AGENT_ALIASES: Record<string, string> = {
  'claude-code': 'claude-code',
  'claude code': 'claude-code',
  'claudecode': 'claude-code',
  'cursor': 'cursor',
  'copilot': 'github-copilot',
  'github copilot': 'github-copilot',
  'github-copilot': 'github-copilot',
};

/** Regex for Windows-style absolute paths: C:\... or D:\... */
const WIN_ABS_PATH_RE = /[A-Za-z]:\\(?:[^\s"'<>|?*\r\n]+)/g;

/** Regex for Unix-style absolute paths starting with / */
const UNIX_ABS_PATH_RE = /(?<!\w)(\/[^\s"'<>|?*\r\n:]{2,})/g;

/**
 * Common timestamp patterns to normalize to ISO-8601 UTC:
 * - 2024-01-15T10:30:00.000Z  → keep as-is (already ISO)
 * - 2024-01-15 10:30:00       → 2024-01-15T10:30:00Z
 * - Jan 15, 2024 10:30 AM     → skip (too ambiguous without timezone)
 */
const DATETIME_SPACE_RE = /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:\s*UTC|\s*Z)?/g;

const home = homedir();

export function normalize(text: string): string {
  let result = text;

  // 1. Windows paths → forward slash, then treat as absolute
  result = result.replace(WIN_ABS_PATH_RE, (match) => {
    // C:\Users\foo\bar → ~/bar (replace home dir portion)
    const forwardSlash = match.replace(/\\/g, '/');
    return homeRelative(forwardSlash);
  });

  // 2. Unix absolute paths → home-relative where applicable
  result = result.replace(UNIX_ABS_PATH_RE, (match) => {
    return homeRelative(match);
  });

  // 3. Datetime with space separator → ISO-8601
  result = result.replace(DATETIME_SPACE_RE, (_match, date, time) => {
    return `${date}T${time}Z`;
  });

  // 4. Agent names → lowercase canonical
  result = normalizeAgentNames(result);

  return result;
}

function homeRelative(path: string): string {
  // Normalize home dir to forward slashes for comparison
  const homeForward = home.replace(/\\/g, '/');
  const pathForward = path.replace(/\\/g, '/');

  if (pathForward.startsWith(homeForward)) {
    return '~' + pathForward.slice(homeForward.length);
  }
  // Also handle Windows-style home in forward-slash form: /Users/xxx or /home/xxx
  // covered by the homedir() call above already
  return pathForward;
}

function normalizeAgentNames(text: string): string {
  // Replace known agent name patterns (word-boundary aware)
  for (const [alias, canonical] of Object.entries(AGENT_ALIASES)) {
    // Escape special regex chars in alias
    const escaped = alias.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'gi');
    text = text.replace(re, canonical);
  }
  return text;
}
