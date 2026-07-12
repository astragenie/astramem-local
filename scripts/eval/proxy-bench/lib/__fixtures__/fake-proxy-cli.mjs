#!/usr/bin/env node
/**
 * Test-only stand-in for the real `astramem-local proxy serve` CLI
 * (feat/feat-458-s2-proxy-core-v2, not on this branch). Mimics just enough
 * of the real contract for proxy-driver.test.ts to exercise spawn / wait-
 * for-boot-line / kill / teardown mechanics without depending on that
 * branch: same argv shape (`proxy serve --port N --upstream <url> --host
 * H`), same boot log line format, and a plain byte relay to the given
 * upstream. This is NOT a substitute for the real proxy's ADR-013
 * byte-transparency/hop-header/loopback guarantees — it exists purely so
 * this harness's own plumbing is testable in isolation. Real S2-AC-4
 * evidence must be produced against the actual built CLI once Wave 2 lands.
 */
import { createServer, request as httpRequest } from 'node:http';

function parseArg(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const args = process.argv.slice(2);
const [sub, subcmd, ...rest] = args;
if (sub !== 'proxy' || subcmd !== 'serve') {
  console.error(`fake-proxy-cli: unsupported invocation (expected "proxy serve ...", got "${args.join(' ')}")`);
  process.exit(1);
}

const port = Number(parseArg(rest, '--port') ?? '0');
const upstream = parseArg(rest, '--upstream');
const host = parseArg(rest, '--host') ?? '127.0.0.1';

if (!upstream) {
  console.error('fake-proxy-cli: --upstream is required');
  process.exit(1);
}
const upstreamUrl = new URL(upstream);

const server = createServer((clientReq, clientRes) => {
  const upstreamReq = httpRequest({
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || 80,
    path: clientReq.url ?? '/',
    method: clientReq.method,
    headers: { ...clientReq.headers, host: upstreamUrl.host },
  }, (upstreamRes) => {
    clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(clientRes);
  });
  upstreamReq.on('error', (err) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'text/plain' });
      clientRes.end(`fake-proxy-cli: upstream unreachable (${err.message})`);
    }
  });
  clientReq.pipe(upstreamReq);
});

server.listen(port, host, () => {
  const bound = server.address();
  const boundPort = typeof bound === 'object' && bound !== null ? bound.port : port;
  // Must match PROXY_SERVING_LINE_RE in ../proxy-driver.ts exactly.
  console.log(`fake-proxy-cli astramem-local proxy serving on ${host}:${boundPort} -> ${upstream}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
