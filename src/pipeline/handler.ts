import type { DB } from '../storage/db.js';
import type { Config } from '../config/config.js';
import type { JobKind } from '../contracts/index.js';

/**
 * Context passed to every job handler.
 * Wave 3 extends this via module augmentation to add:
 *   llm: LLMProvider, embed: EmbedProvider, vector: VectorStore, memoryRepo: MemoryRepo
 */
export interface HandlerCtx {
  db: DB;
  config: Config;
}

/**
 * A job handler is a named unit of async work keyed to a JobKind.
 * Throw to signal failure; the worker increments attempts and transitions state.
 */
export interface JobHandler {
  kind: JobKind;
  handle(payload: unknown, ctx: HandlerCtx): Promise<void>;
}
