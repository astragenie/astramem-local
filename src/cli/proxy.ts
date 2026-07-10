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
 * Deliberately has NO HTTP control-plane routes in S2 (no /status, no
 * /config) — status/config introspection for the proxy is CLI/file-level
 * only for this slice; a Bearer-gated control-plane surface (ADR-013
 * Decision 4) is deferred to whichever later slice first needs one. S2's
 * HTTP surface is exactly one thing: the transparent forward path in
 * src/proxy/server.ts.
 */
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { isLoopbackHost } from '../server/lib/network.js';
import { startProxyServer } from '../proxy/server.js';
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

  const { cfg } = resolveRuntimeConfig({});

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

  const handle = await startProxyServer({ port, host, upstream });
  console.log(`${ts()} astramem-local proxy serving on ${handle.host}:${handle.port} -> ${upstream}`);

  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
