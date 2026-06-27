import type { JobKind } from '../contracts/index.js';
import type { JobHandler } from './handler.js';

/**
 * Registry of job handlers keyed by JobKind.
 * register() is idempotent — re-registering the same kind overwrites.
 */
export class HandlerRegistry {
  private readonly map = new Map<JobKind, JobHandler>();

  /** Register a handler for its declared kind. */
  register(handler: JobHandler): void {
    this.map.set(handler.kind, handler);
  }

  /** Look up a handler by kind. Returns undefined if none registered. */
  get(kind: JobKind): JobHandler | undefined {
    return this.map.get(kind);
  }

  /** All registered kinds (for diagnostics). */
  registeredKinds(): JobKind[] {
    return [...this.map.keys()];
  }
}
