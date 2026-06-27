/**
 * Correlation ID — request_id propagation via AsyncLocalStorage.
 *
 * Usage:
 *   - On each incoming HTTP request: call runWithRequestId(uuid, fn)
 *   - Anywhere in the call stack: call getRequestId() to retrieve the current ID
 *   - child loggers can bind it via logger.child({ request_id: getRequestId() })
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export { randomUUID };

const storage = new AsyncLocalStorage<string>();

/**
 * Run fn inside a context that has request_id set.
 * Callers that do not call this will see undefined from getRequestId().
 */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run(requestId, fn);
}

/**
 * Retrieve the current request_id from the async context.
 * Returns undefined when called outside a runWithRequestId scope.
 */
export function getRequestId(): string | undefined {
  return storage.getStore();
}

/**
 * Generate a new RFC 4122 v4 UUID suitable for use as a request_id.
 */
export function newRequestId(): string {
  return randomUUID();
}
