/**
 * Extended HandlerCtx for Wave 3 distillation.
 *
 * Wave 3 adds providers, vector store, and repos to the handler context.
 * We define an extended type here WITHOUT editing the frozen src/contracts/*
 * or the base HandlerCtx in handler.ts.
 *
 * The startWorker() call in serve.ts/worker will be updated to pass an
 * ExtendedHandlerCtx. Handlers that need providers type-assert to this.
 */

import type { HandlerCtx } from './handler.js';
import type { LLMProvider, EmbedProvider } from '../contracts/index.js';
import type { MemoryRepo } from '../storage/memories.js';
import type { SqliteVecStore } from '../vector/sqlite-vec.js';
import type { ProviderSet } from '../providers/index.js';

export interface ExtendedHandlerCtx extends HandlerCtx {
  providers: ProviderSet;
  memoryRepo: MemoryRepo;
  vecStore: SqliteVecStore;
}

/**
 * Type guard — true when ctx has the Wave 3 provider extensions.
 */
export function isExtendedCtx(ctx: HandlerCtx): ctx is ExtendedHandlerCtx {
  return (
    'providers' in ctx &&
    ctx.providers !== null &&
    typeof ctx.providers === 'object'
  );
}
