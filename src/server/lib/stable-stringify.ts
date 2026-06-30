/**
 * Canonical JSON stringification with sorted object keys.
 * INPUT CONTRACT: caller must pass Zod-validated plain-JSON values only.
 * Supported: null, boolean, number (finite), string, array (order preserved), plain object.
 * UNSUPPORTED (throws or produces lossy output): Date, BigInt, Symbol, undefined,
 * cyclic references, class instances. Feeding any of these is a programming error.
 *
 * Used by ingest route to hash request bodies for idempotency replay.
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
