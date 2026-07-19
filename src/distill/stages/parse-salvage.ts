/**
 * FEAT-552 sub-scope A — deterministic extraction-parse hardening.
 *
 * Two lexer-lite (NOT full-parse) utilities consumed by 05-extract.ts's
 * `tryParseAtoms` AFTER the normal `JSON.parse` + Zod validation attempt has
 * already failed (or a duplicate key is detected BEFORE that attempt is even
 * made — see `detectDuplicateKey`). Neither function ever runs on, or
 * changes the result of, a response that parses cleanly on the first try —
 * the healthy path through `tryParseAtoms` never touches this module.
 *
 * AC-A1 (JSON truncation salvage): `maxTokens` cutting a response off
 * mid-atom used to be indistinguishable from any other parse failure —
 * `tryParseAtoms` returned null, the caller threw TransientError, and the
 * worker retried the WHOLE chunk from scratch even though most of the
 * response was perfectly good JSON. `salvageTruncatedAtoms` recovers the
 * atoms that DID finish before the cutoff instead of discarding all of them.
 *
 * AC-A2 (duplicate-key pre-parse detector): the 2026-07-16 qwen3.5 collapse
 * (`{"text":"A","text":"B"}` — valid JSON, but `JSON.parse`'s last-key-wins
 * semantics silently drop "A") is a class `JSON.parse` cannot detect on its
 * own by definition — the string IS valid JSON. `detectDuplicateKey` walks
 * the raw text as a bracket-depth-aware token stream (tracking one `Set` of
 * seen keys per open object scope) and flags a repeat key within the SAME
 * object scope before a lossy `JSON.parse` ever runs.
 */

/** One key-scope frame: `isObject` distinguishes an object scope (which
 * tracks its own seen-keys set) from an array scope (which does not — array
 * elements are never "keys"). */
interface DuplicateKeyFrame {
  isObject: boolean;
  keys?: Set<string>;
}

/**
 * Scan raw JSON-shaped text for a duplicate key within a single object
 * scope. Deliberately a lexer, not a parser: it never builds a value tree,
 * it only tracks brace/bracket depth and, per open object scope, which
 * string tokens have already appeared in "key position" (immediately
 * followed — after optional whitespace — by a `:`, which is exactly what
 * distinguishes a JSON key from a JSON string VALUE; a value string is
 * followed by `,`, `}`, or `]`, never `:`).
 *
 * Returns the first duplicated key name found, or `null` if every object
 * scope in the text has all-unique keys. Nested objects each get their own
 * fresh key set (pushed on `{`, popped on `}`), so a key name repeating
 * across DIFFERENT nesting levels — completely normal JSON — is not a false
 * positive.
 */
export function detectDuplicateKey(jsonText: string): string | null {
  const stack: DuplicateKeyFrame[] = [];
  const n = jsonText.length;
  let i = 0;

  while (i < n) {
    const ch = jsonText[i];

    if (ch === '"') {
      const strStart = i;
      i++;
      while (i < n) {
        if (jsonText[i] === '\\') { i += 2; continue; }
        if (jsonText[i] === '"') break;
        i++;
      }
      const content = jsonText.slice(strStart + 1, i);
      i++; // step past the closing quote

      const top = stack[stack.length - 1];
      if (top?.isObject) {
        let j = i;
        while (j < n && /\s/.test(jsonText[j]!)) j++;
        if (jsonText[j] === ':') {
          // This string is in KEY position for the current object scope.
          if (top.keys!.has(content)) return content;
          top.keys!.add(content);
        }
      }
      continue;
    }

    if (ch === '{') { stack.push({ isObject: true, keys: new Set() }); i++; continue; }
    if (ch === '[') { stack.push({ isObject: false }); i++; continue; }
    if (ch === '}' || ch === ']') { stack.pop(); i++; continue; }
    i++;
  }

  return null;
}

export interface SalvageResult {
  /** Raw (unvalidated) atom objects successfully reconstructed. Caller runs
   * these through the SAME AtomSchema/coerce/filter pipeline as a normal
   * parse — salvage only repairs JSON shape, it never bypasses validation. */
  atoms: unknown[];
  /** Count of atom objects salvage reconstructed and parsed cleanly. */
  recoveredCount: number;
  /** Count of atom-shaped fragments salvage could NOT use: a trailing
   * object cut off mid-write by the token limit, or a complete-looking
   * object whose own text contained a duplicate key (AC-A2) and was
   * therefore rejected rather than silently last-key-wins parsed. */
  lostCount: number;
}

/**
 * Deterministically recover complete `atoms[]` entries from JSON text that
 * failed a normal `JSON.parse` — typically because a token-limited LLM
 * response was cut off mid-object. Operates on text starting at the first
 * `{` of the response (the caller passes `text.slice(start)`, UNBOUNDED —
 * deliberately not sliced to any `lastIndexOf('}')` guess, since a
 * genuinely truncated response has no matching final brace for the whole
 * wrapper object; bounding by one would silently discard the truncated
 * tail this function exists to recover from).
 *
 * Algorithm: locate the `"atoms":[` key, then walk forward tracking
 * string/escape state and brace depth. Every time a `{` opened at array-
 * element depth (depth 0 relative to the array) closes again, that
 * substring is one complete atom-object candidate. A trailing `{` that
 * never closes (end of text reached, or entered a string that never
 * terminated) is truncation — reflected in `lostCount`, not included in
 * `atoms`. Each complete candidate is re-checked for a duplicate key
 * (AC-A2) before being JSON.parse'd on its own — a duplicate-keyed
 * candidate is counted as lost, not silently collapsed.
 *
 * Returns `null` when there is no `"atoms":[` key to anchor on, or when
 * nothing at all could be recovered (`recoveredCount` would be 0) — the
 * caller's existing TransientError-and-retry path handles both identically
 * to today's behavior.
 */
export function salvageTruncatedAtoms(jsonText: string): SalvageResult | null {
  const atomsKeyMatch = /"atoms"\s*:\s*\[/.exec(jsonText);
  if (!atomsKeyMatch) return null;

  const arrStart = atomsKeyMatch.index + atomsKeyMatch[0].length;
  const n = jsonText.length;
  let depth = 0;
  let inString = false;
  let objStart = -1;
  const objTexts: string[] = [];
  let i = arrStart;

  for (; i < n; i++) {
    const ch = jsonText[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        objTexts.push(jsonText.slice(objStart, i + 1));
        objStart = -1;
      }
      continue;
    }
    if (ch === ']' && depth === 0) break; // clean end of the atoms array
  }

  // Reached end of text (or the loop broke) while mid-object, mid-string,
  // or with an unclosed `{` — that's the truncated tail.
  const truncatedTail = depth !== 0 || objStart !== -1 || inString;

  if (objTexts.length === 0) return null;

  const atoms: unknown[] = [];
  let recoveredCount = 0;
  let lostCount = truncatedTail ? 1 : 0;

  for (const objText of objTexts) {
    if (detectDuplicateKey(objText) !== null) {
      lostCount++;
      continue;
    }
    try {
      atoms.push(JSON.parse(objText));
      recoveredCount++;
    } catch {
      lostCount++;
    }
  }

  if (recoveredCount === 0) return null;

  return { atoms, recoveredCount, lostCount };
}
