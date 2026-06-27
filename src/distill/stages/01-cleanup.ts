/**
 * Stage 1 — Cleanup (deterministic)
 *
 * - Normalize line endings to \n
 * - Deduplicate consecutive blank lines (max 2)
 * - Remove repeated tool-output blocks (identical lines appearing 3+ times consecutively)
 * - Strip trailing whitespace per line
 */

/** Maximum consecutive blank lines to keep */
const MAX_BLANK_LINES = 2;

/** Number of identical consecutive lines that triggers dedup */
const REPEAT_THRESHOLD = 3;

export function cleanup(text: string): string {
  // 1. Normalize line endings
  let result = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 2. Strip trailing whitespace per line
  result = result
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n');

  // 3. Deduplicate repeated consecutive identical lines (tool output spam)
  result = deduplicateRepeatedLines(result);

  // 4. Collapse excess blank lines
  result = collapseBlankLines(result);

  // 5. Trim leading/trailing whitespace
  return result.trim();
}

/**
 * If the same non-empty line appears REPEAT_THRESHOLD or more times in a row,
 * collapse them to a single instance.
 */
function deduplicateRepeatedLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      out.push(line);
      i++;
      continue;
    }

    // Count consecutive identical lines
    let count = 1;
    while (i + count < lines.length && lines[i + count] === line) {
      count++;
    }

    if (count >= REPEAT_THRESHOLD) {
      // Replace run with single occurrence + indicator
      out.push(line);
    } else {
      for (let j = 0; j < count; j++) out.push(line);
    }
    i += count;
  }

  return out.join('\n');
}

/**
 * Collapse runs of more than MAX_BLANK_LINES consecutive blank lines.
 */
function collapseBlankLines(text: string): string {
  // Replace 3+ consecutive newlines with 2 newlines (= MAX_BLANK_LINES blank line)
  return text.replace(/\n{3,}/g, '\n\n');
}
