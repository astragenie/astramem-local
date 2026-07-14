/**
 * `astramem-local proxy serve --port N --upstream <url> [--host H]`
 * (FEAT-458 S2, ADR-013). Config-driven defaults (`cfg.proxy.port` /
 * `cfg.proxy.upstream`) are used when the corresponding flag is omitted; an
 * explicit CLI flag always wins over config.yaml, matching `serve`'s own
 * CLI-flag-over-config precedence (src/config/resolve-runtime.ts).
 *
 * Loopback-only bind (ADR-013 review decision 2): a non-loopback --host is
 * refused outright with a pinned error string + exit 1, checked BEFORE the
 * server ever attempts to listen — there is no v1 remote-bind mode and no
 * shared-secret escape hatch.
 *
 * Release no-go hard gate (release scoping decision): the proxy is
 * EXPERIMENTAL and not production-ready for the first release. `proxyCommand`
 * refuses to start the listener at all unless `cfg.proxy.experimental` is
 * explicitly `true` in config.yaml — no CLI flag, no wizard prompt.
 *
 * Deliberately has NO HTTP control-plane routes (no /status, no /config) —
 * status/config introspection for the proxy is CLI/file-level only; a
 * Bearer-gated control-plane surface (ADR-013 Decision 4) is deferred to
 * whichever later slice first needs one. The HTTP surface is exactly one
 * thing: the transparent forward path in src/proxy/server.ts.
 *
 * FEAT-458 S3: when `cfg.proxy.capture.enabled` is true (default false,
 * ADR-013 §5 — a second, independent opt-in on top of `proxy.enabled`
 * itself), this is the ONE place that wires the capture-fork module
 * (src/capture/proxy.ts) to the relay via `ProxyServeOpts.createTee`. No CLI
 * flag exists for this — config-driven only, matching the rest of this
 * block's "no wizard prompt, no one-click toggle" framing (§5); a user who
 * wants capture on has to opt in twice, deliberately, in config.yaml.
 */
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { isLoopbackHost } from '../server/lib/network.js';
import { startProxyServer } from '../proxy/server.js';
import { createProxyCaptureTee } from '../capture/proxy.js';
import { PKG_VERSION } from '../server/lib/wire-meta.js';
import { ts } from '../log/logger.js';

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function proxyCommand(rest: string[]): Promise<void> {
  const [sub, ...subRest] = rest;

  if (sub !== 'serve') {
    console.error(`proxy: unknown subcommand "${sub ?? ''}" (expected: serve)`);
    process.exitCode = 1;
    return;
  }

  const { cfg, dataDir } = resolveRuntimeConfig({});

  const portArg = parseArg(subRest, '--port');
  const upstreamArg = parseArg(subRest, '--upstream');
  const hostArg = parseArg(subRest, '--host');

  const host = hostArg ?? '127.0.0.1';

  // Checked before anything else touches the network — a bad --host must
  // never get as far as an attempted bind. Exact string pinned by a
  // regression test (tests/proxy/loopback-refusal.test.ts): any change here
  // is a breaking-contract change, not a wording tweak.
  if (!isLoopbackHost(host)) {
    console.error(`proxy: refusing non-loopback bind (${host}) — v1 is loopback-only per ADR-013`);
    process.exitCode = 1;
    return;
  }

  // Release no-go hard gate: the proxy is EXPERIMENTAL and not enabled for
  // this release. Checked BEFORE upstream is even parsed and BEFORE the
  // listener is ever started — same "fail before touching the network"
  // posture as the loopback check above. `cfg.proxy.enabled` alone was never
  // a start gate for this subcommand (see this file's module doc comment —
  // the proxy is only ever invoked via its own explicit subcommand), so this
  // is the ONE check standing between an operator and a running proxy
  // process; it must require an explicit `true`, not just a falsy check.
  if (cfg.proxy.experimental !== true) {
    console.error(
      'proxy: the LLM proxy is EXPERIMENTAL and not enabled for this release — set proxy.experimental: true in config.yaml to opt in.',
    );
    process.exitCode = 1;
    return;
  }

  const port = portArg !== undefined ? Number(portArg) : cfg.proxy.port;
  const upstream = upstreamArg ?? cfg.proxy.upstream;

  if (!upstream) {
    console.error('proxy serve: --upstream <url> is required (or set proxy.upstream in config.yaml)');
    process.exitCode = 1;
    return;
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(upstream);
  } catch {
    console.error(`proxy serve: --upstream "${upstream}" is not a valid URL`);
    process.exitCode = 1;
    return;
  }
  if (upstreamUrl.protocol !== 'http:' && upstreamUrl.protocol !== 'https:') {
    console.error(`proxy serve: --upstream must be http:// or https:// (got "${upstreamUrl.protocol}")`);
    process.exitCode = 1;
    return;
  }

  // FEAT-458 S3 / ADR-013 §5: default OFF at every layer this reads from —
  // the schema default (src/config/config.ts), the config writer
  // (src/config/writer.ts), and here: createTee is only ever constructed
  // when the config explicitly says so, never implied by `proxy.enabled`
  // alone. Omitting `createTee` entirely (not passing an always-off one)
  // reproduces S2's exact zero-listener forward path when capture is off.
  const createTee = cfg.proxy.capture.enabled
    ? createProxyCaptureTee({
        dataDir,
        clientVersion: PKG_VERSION,
        // Reuses the SAME relevance-gate config surface hook-tap capture
        // already exposes (ADR-013 doesn't introduce a second one) —
        // src/capture/relevance-gate.ts's taxonomy and dedup window apply
        // identically here.
        relevanceGate: cfg.capture.autoCapture.relevanceGate,
        // A3 (Wave A): the operator's real resolved config drives
        // spool-write redaction (src/ingest/spool.ts writeToSpool) — same
        // security.redaction.* settings the daemon's own ingest-time
        // redaction honors, never a second drifting posture.
        redactConfig: cfg,
      })
    : undefined;

  const handle = await startProxyServer({
    port,
    host,
    upstream,
    createTee,
    upstreamTimeoutMs: cfg.proxy.upstreamTimeoutMs,
  });
  console.log(`${ts()} astramem-local proxy serving on ${handle.host}:${handle.port} -> ${upstream}`);
  if (cfg.proxy.capture.enabled) {
    console.log(`${ts()} astramem-local proxy: capture is ON (capture_source=proxy) -> ${dataDir}`);
  }

  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
