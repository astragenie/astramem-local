import { parentPort, workerData } from 'node:worker_threads';
import { OnnxEmbedProvider, type OnnxEmbedConfig } from './onnx.js';
import { childLogger } from '../../log/logger.js';

/**
 * ADR-019 Decision 2(d) — worker_thread entry point hosting ONNX inference.
 *
 * Spawned by `OnnxWorkerHostProvider` (onnx-worker-host.ts, the main-thread
 * proxy). Reuses `OnnxEmbedProvider` UNCHANGED — same pooling/tokenization/
 * registry resolution logic as the in-process path, just running on a
 * dedicated OS-schedulable thread instead of the daemon's main event loop.
 * This is the piece that actually fixes the measured hazard: `session.run()`
 * still blocks WHICHEVER thread calls it (see the validation artifact,
 * `.claude/artifacts/crew/validations/20260715T000000Z-validation-onnx-embed-event-loop-block.md`
 * — ~400-950ms per call), but that thread is now this worker's, not the
 * Fastify/MCP event loop's.
 *
 * Message protocol (see onnx-worker-host.ts for the matching host side):
 *   host -> worker: {type:'embed', id, texts} | {type:'health', id} | {type:'cancel', id}
 *   worker -> host: {type:'ready'} | {type:'ready-error', message}
 *                 | {type:'embed-result', id, buffers} (buffers is the
 *                   transfer list — each Float32Array's own ArrayBuffer,
 *                   moved not copied)
 *                 | {type:'embed-error', id, message}
 *                 | {type:'health-result', id, health}
 */

if (!parentPort) {
  throw new Error('onnx-worker.ts must be run inside a worker_thread (parentPort is null)');
}
const port = parentPort;

const log = childLogger({ component: 'onnx-worker' });

const config = (workerData ?? {}) as OnnxEmbedConfig;
const provider = new OnnxEmbedProvider(config);

// Per-request AbortControllers so a host-side timeout/AbortSignal can be
// relayed into the SAME between-texts checkpoint OnnxEmbedProvider.embed()
// already honors (ADR-018) — this worker doesn't reimplement cancellation,
// it just gives the host a way to trigger the existing mechanism remotely.
const abortControllers = new Map<number, AbortController>();

interface EmbedReq { type: 'embed'; id: number; texts: string[] }
interface HealthReq { type: 'health'; id: number }
interface CancelReq { type: 'cancel'; id: number }
type HostMessage = EmbedReq | HealthReq | CancelReq;

function isHostMessage(msg: unknown): msg is HostMessage {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';
}

port.on('message', (msg: unknown) => {
  if (!isHostMessage(msg)) return;
  if (msg.type === 'cancel') {
    abortControllers.get(msg.id)?.abort();
    return;
  }
  if (msg.type === 'health') {
    void handleHealth(msg);
    return;
  }
  if (msg.type === 'embed') {
    void handleEmbed(msg);
  }
});

async function handleHealth(msg: HealthReq): Promise<void> {
  try {
    const health = await provider.health();
    port.postMessage({ type: 'health-result', id: msg.id, health });
  } catch (err) {
    port.postMessage({
      type: 'health-result',
      id: msg.id,
      health: {
        ok: false,
        model: provider.model,
        dim: provider.dim,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

async function handleEmbed(msg: EmbedReq): Promise<void> {
  const controller = new AbortController();
  abortControllers.set(msg.id, controller);
  try {
    const vectors = await provider.embed(msg.texts, controller.signal);
    // Float32Array.buffer is typed ArrayBufferLike (covers SharedArrayBuffer)
    // but every vector here was freshly allocated by `new Float32Array(row)`
    // in onnx.ts's pooling step — always a real, transferable ArrayBuffer.
    const buffers = vectors.map((v) => v.buffer) as ArrayBuffer[];
    // Transfer, not copy — `buffers` doubles as both the payload and the
    // transfer list (ADR-019 AC: vectors cross the thread boundary without a
    // copy). Each Float32Array was freshly allocated by the pooling step
    // (onnx.ts's poolMeanNormalize/poolClsNormalize), so no other reference
    // to these buffers exists on the worker side to be invalidated.
    port.postMessage({ type: 'embed-result', id: msg.id, buffers }, buffers);
  } catch (err) {
    port.postMessage({
      type: 'embed-error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    abortControllers.delete(msg.id);
  }
}

// Load the model ONCE at spawn (ADR-019 AC) — every embed()/health() request
// after this reuses OnnxEmbedProvider's own memoized session (getBackend()).
// A load failure is reported, not thrown uncaught: an uncaught throw here
// would fire the host's 'error'/'exit' handlers with a less specific message
// than this loud, structured 'ready-error'.
provider
  .preload()
  .then(() => {
    log.info({ model: provider.model, dim: provider.dim }, 'onnx worker model loaded, ready');
    port.postMessage({ type: 'ready' });
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, model: provider.model }, 'onnx worker failed to load model');
    port.postMessage({ type: 'ready-error', message });
  });
