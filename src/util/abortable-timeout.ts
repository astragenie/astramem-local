/**
 * Shared timeout-with-cancellation helper (issue #261).
 *
 * Reconciles the near-identical `withTimeout`/`Promise.race` copies that
 * used to live independently in src/search/decompose.ts, src/search/rerank.ts,
 * src/doctor/probes/llm-chat-probe.ts, and src/doctor/probes/embed-probe.ts.
 * All four raced a promise against a `setTimeout` and, on timeout, simply
 * abandoned the promise — the underlying request (an Ollama generation, a
 * cross-encoder sidecar call) kept running to completion in the background,
 * invisible to the caller, holding the callee's execution slot for however
 * long it actually took (measured: 9-30s of orphaned Ollama generation
 * against an 800ms decompose budget or a 300ms rerank budget). Lives in
 * src/util/ rather than src/search/ because doctor/probes/ needs it too and
 * has no reason to depend on the search module.
 *
 * `run` receives an `AbortSignal` that fires the instant the timeout
 * elapses. Correctness of the CANCELLATION (not just the timeout) depends on
 * `run` actually wiring that signal into its underlying I/O — e.g. passing
 * it as (part of) a fetch `signal`, combined via `AbortSignal.any([...])`
 * with any timeout the callee already applies internally, never replacing
 * it. This helper only supplies the cancellation trigger; it cannot force a
 * callee to honor it.
 *
 * Still races against the timer explicitly (not just relying on the
 * rejection `run` produces once its own signal is observed aborted) so a
 * callee that ignores the signal degrades to the pre-fix behavior — blocked
 * until the timer fires — rather than hanging the caller forever.
 */
export function withAbortableTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  makeTimeoutError: () => Error,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = makeTimeoutError();
      controller.abort(err);
      reject(err);
    }, ms);
    run(controller.signal).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
