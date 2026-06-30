/**
 * Stable (canonical) JSON serialization — keys sorted recursively so that
 * the same logical object always produces the same byte sequence regardless
 * of the insertion order used by the serialising client.
 *
 * Used to compute idempotency body hashes that are independent of key order.
 */

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }

  // Object — sort keys and recurse
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(k => {
      const serialisedKey = JSON.stringify(k);
      const serialisedVal = stableStringify((value as Record<string, unknown>)[k]);
      return `${serialisedKey}:${serialisedVal}`;
    });

  return '{' + sorted.join(',') + '}';
}
