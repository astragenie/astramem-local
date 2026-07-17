import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../storage/db.js';
import type { EmbedProvider } from '../contracts/index.js';
import { healthRoute } from './routes/health.js';
import { versionRoute } from './routes/version.js';
import { whoamiRoute } from './routes/whoami.js';
import { ingestRoute } from './routes/ingest.js';
import { searchRoute } from './routes/search.js';
import { memoryRoute } from './routes/memory.js';
import { lifecycleRoutes } from './routes/lifecycle.js';
import { capturePurgeRoutes } from './routes/capture-purge.js';
import { whyRoute } from './routes/why.js';
import { agentsRoute } from './routes/agents.js';
import { profileRoute } from './routes/profile.js';
import { digestRoute } from './routes/digest.js';
import { recallRoute } from './routes/recall.js';
import { mcpRoute } from './routes/mcp.js';
import { dashboardRoute } from './routes/dashboard.js';
import { dashboardConsolidationRoute } from './routes/dashboard-consolidation-html.js';
import { dashboardJobsRoute } from './routes/dashboard-jobs-html.js';
import { dashboardLogsRoute } from './routes/dashboard-logs-html.js';
import { dashboardSearchRoute } from './routes/dashboard-search-html.js';
import { dashboardApiRoute } from './routes/dashboard-api-html.js';
import { dashboardProvidersRoute } from './routes/dashboard-providers-html.js';
import { memoryToolRoute } from './routes/memory-tool.js';
import { consolidationRoutes } from './routes/consolidation.js';
import { entitiesRoute } from './routes/entities.js';
import { syncStatusRoute } from './routes/sync-status.js';
import { makeFakeVec } from '../search/search.js';
import { childLogger, logger } from '../log/logger.js';
import { newRequestId, runWithRequestId } from '../log/correlation.js';
import { type Config, defaultConfig } from '../config/config.js';
import type { HealthState } from './health-state.js';
import { isLoopbackHost, isLoopbackHostHeader } from './lib/network.js';
import { originIsLoopback } from './lib/origin-guard.js';
import { safeBearerEqual } from './lib/secure-compare.js';

/** Default no-op embed provider used when no real provider is injected.
 * FEAT-409: dim derived from config.embedding.dim (defaults to
 * DEFAULT_EMBED_DIM via defaultConfig()) rather than a literal, so the
 * noop provider's fake vectors always match whatever schema dim is live. */
function makeNoopEmbed(dim: number): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'noop',
    dim,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t, dim)),
    health: async () => ({ ok: false, model: 'noop', dim, error: 'no provider configured' })
  };
}

export interface AppOpts {
  db: DB;
  token: string;
  /** Embed provider injected for search + remember routes. Defaults to fake/noop. */
  embed?: EmbedProvider;
  /** Server config — used by dashboard route for budget cap display. Defaults to defaultConfig(). */
  config?: Config;
  /** Live daemon health snapshot (degraded-start, D3). Optional — /health
   *  omits the status/embed fields when absent (e.g. bare test apps). */
  healthState?: HealthState;
}

export async function buildApp(opts: AppOpts): Promise<FastifyInstance> {
  // Fastify's internal logger is disabled. We emit request lifecycle logs
  // manually via the onResponse hook below, using our pino instance + the
  // request_id we generate in onRequest. This sidesteps a type incompatibility
  // between FastifyBaseLogger and FastifyInstance<never logger>.
  const app = Fastify({
    logger: false,
    // Long Codex/Claude sessions routinely exceed Fastify's 1MiB default —
    // an oversized transcript should not 413 (wire: POST /ingest/transcript).
    bodyLimit: 10 * 1024 * 1024,
    // A stuck handler must not hold a connection forever (recall with a cold
    // embed can be slow, but 60s is the ceiling — matches the LLM timeout).
    requestTimeout: 60_000,
  });
  const config = opts.config ?? defaultConfig();
  const embed = opts.embed ?? makeNoopEmbed(config.embedding.dim);

  // The dashboard's accept/reject buttons are plain HTML <form method="post">
  // elements (no JS on the dashboard by design), so the browser submits
  // application/x-www-form-urlencoded. Fastify ships no parser for that type
  // and 415s the request before the route runs (FST_ERR_CTP_INVALID_MEDIA_TYPE).
  // Those routes take no meaningful body — parse to an empty object rather than
  // pulling in @fastify/formbody for form fields nothing reads.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, _body, done) => {
    done(null, {});
  });

  // Assign a request_id to every incoming request and expose it on the reply header.
  app.addHook('onRequest', async (req, reply) => {
    const requestId = newRequestId();
    // Store on req so downstream hooks / routes can read it
    (req as unknown as Record<string, unknown>)['requestId'] = requestId;
    // Bind to async local storage for propagation into jobs queued from this request
    runWithRequestId(requestId, () => {
      // noop — storage set; pino child created in route handlers
    });
    void reply.header('x-request-id', requestId);
  });

  // Log HTTP request start + completion with required fields.
  app.addHook('onResponse', (req, reply, done) => {
    const requestId = (req as unknown as Record<string, unknown>)['requestId'] as string | undefined;
    const log = childLogger({ request_id: requestId ?? 'unknown' });
    log.info({
      method: req.method,
      path: req.url,
      status: reply.statusCode,
    }, 'request complete');
    done();
  });

  // Auth check — scrub the Authorization header value from any error logs.
  // /dashboard and its sub-pages (/dashboard/consolidation, /dashboard/jobs,
  // /dashboard/search — FEAT-410) validate their own auth via the shared
  // checkDashboardAuth helper (dashboard-auth.ts) — Bearer, ?token=/cookie,
  // or (when devNoAuthActive, computed below and threaded into each
  // dashboard route factory) the same loopback-only no-auth bypass API
  // routes get. Always exempt on prefix here, not just the exact path.
  // /health and /version are public ONLY while the daemon is bound to loopback
  // (default). FEAT-406: opting into a non-local bind (config.network.host set
  // to anything but 127.0.0.1/localhost/::1) requires Bearer auth on BOTH
  // routes together — isLoopbackHost is the one predicate that decides this,
  // so the bind and the auth boundary can never drift apart.
  const isLocalBind = isLoopbackHost(config.network.host);

  // Dev no-auth mode (Config['auth'] doc comment has the full rationale).
  // Refused — forced back to false with a loud boot-time log, daemon keeps
  // booting normally — whenever the bind isn't loopback: devNoAuth on a
  // LAN/remote bind would mean credential-free exposure to the whole
  // network, which must be structurally impossible, not just discouraged.
  // A hard boot-time exit was considered and rejected: it would turn one
  // dev-convenience config combination into a full daemon outage, whereas
  // forcing this one flag false keeps every other route working exactly as
  // it already does on a non-loopback bind (Bearer required — the existing,
  // tested FEAT-406 behavior) — fail-closed on auth without fail-stopping
  // the whole process.
  const devNoAuthConfigured = config.auth?.devNoAuth === true;
  if (devNoAuthConfigured && !isLocalBind) {
    logger.warn(
      { host: config.network.host },
      'auth.devNoAuth=true but network.host is not loopback — refusing to skip auth; ' +
      'Bearer token is still required on every route. Set network.host back to 127.0.0.1 ' +
      '(or localhost/::1) to use dev no-auth mode.',
    );
  }
  const devNoAuthActive = devNoAuthConfigured && isLocalBind;

  // Boot-readiness gate (Wave 0 Item 3, durable boot-race fix): while
  // healthState.ready is explicitly false, only /health, /health/full, and
  // /version may answer — every other route (auth-required or not,
  // including /dashboard) 503s rather than touching a possibly-unmigrated
  // DB. serve.ts's non-strict boot path binds the port BEFORE running
  // migrate/recoverOrphans/provider-setup, so a request landing in that
  // window must never reach a route that queries tables that may not exist
  // yet. HealthState.ready defaults to `true` (see health-state.ts) — this
  // hook is a no-op for every caller that doesn't know about the concept
  // (bare test apps, hand-built healthState objects), and runs BEFORE the
  // auth hook below so a starting daemon doesn't even need a valid token to
  // learn it should retry shortly.
  app.addHook('preHandler', async (req, reply) => {
    if (!opts.healthState || opts.healthState.ready) return;
    const path = req.url.split('?')[0];
    if (path === '/health' || path === '/health/full' || path === '/version') return;
    return reply.code(503).send({
      ok: false,
      error: { code: 'starting', message: 'astramem-local is still starting up (migrating/initializing) — retry shortly' },
    });
  });

  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path === '/dashboard' || path?.startsWith('/dashboard/')) return;
    if (isLocalBind && (path === '/health' || path === '/version')) return;

    if (devNoAuthActive) {
      // DNS-rebinding defense: the Bearer token was also the one thing
      // stopping an arbitrary website the operator's browser visits from
      // reading the whole memory store via `fetch('http://127.0.0.1:7777/
      // ...')`. With auth skipped entirely, the Host header is the only
      // remaining signal that the request actually originated from a
      // loopback-addressed client rather than a rebound hostname — reject
      // anything else outright (see isLoopbackHostHeader doc comment).
      const hostHeader = req.headers.host ?? '';
      if (!isLoopbackHostHeader(hostHeader)) {
        const requestId = (req as unknown as Record<string, unknown>)['requestId'] as string | undefined;
        childLogger({ request_id: requestId ?? 'unknown' }).warn(
          { method: req.method, path: req.url, host: hostHeader },
          'dev no-auth mode: rejected non-loopback Host header',
        );
        return reply.code(403).send({ error: 'forbidden', reason: 'non-loopback Host header' });
      }
      // Same CSRF hole dashboard-auth.ts's checkDashboardAuth closes: a form
      // POST's Host header is always the target (loopback), never the
      // calling page, so a malicious page's credential-free POST would
      // otherwise sail through here too. See lib/origin-guard.ts doc comment.
      const origin = req.headers.origin;
      if (origin && !originIsLoopback(origin)) {
        const requestId = (req as unknown as Record<string, unknown>)['requestId'] as string | undefined;
        childLogger({ request_id: requestId ?? 'unknown' }).warn(
          { method: req.method, path: req.url, origin },
          'dev no-auth mode: rejected non-loopback Origin header',
        );
        return reply.code(403).send({ error: 'forbidden', reason: 'non-loopback Origin header' });
      }
      return;
    }

    // FEAT-430: constant-time compare — a naive `!==` leaks the token via
    // response-timing (first differing byte short-circuits the compare).
    const auth = req.headers.authorization ?? '';
    if (!safeBearerEqual(auth, `Bearer ${opts.token}`)) {
      const requestId = (req as unknown as Record<string, unknown>)['requestId'] as string | undefined;
      childLogger({ request_id: requestId ?? 'unknown' }).warn(
        { method: req.method, path: req.url },
        'unauthorized request',
      );
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // Unhandled route errors: log the full error server-side, return a
  // sanitized body (no stack, no internals) with the original status when a
  // route set one (e.g. Fastify's own 413/400), else 500. Existing 4xx
  // paths return their own bodies and never reach this handler.
  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as Error & { statusCode?: number; code?: string };
    const requestId = (req as unknown as Record<string, unknown>)['requestId'] as string | undefined;
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    childLogger({ request_id: requestId ?? 'unknown' }).error(
      { method: req.method, path: req.url, status, error_message: err.message, error_kind: err.name },
      'request failed',
    );
    void reply.code(status).send({
      ok: false,
      error: { code: status === 500 ? 'internal' : String(err.code ?? status), message: status === 500 ? 'internal error' : err.message },
    });
  });

  await app.register(healthRoute(config, opts.db, opts.healthState));
  await app.register(versionRoute);
  // Issue #129: NOT added to the loopback public-path exemption above —
  // always auth-required, so `connect` flows can verify a bearer works.
  await app.register(whoamiRoute);
  await app.register(ingestRoute(opts.db, config));
  await app.register(searchRoute(opts.db, embed, config));
  await app.register(memoryRoute(opts.db));
  await app.register(lifecycleRoutes(opts.db));
  await app.register(capturePurgeRoutes(opts.db, config));
  await app.register(whyRoute(opts.db));
  await app.register(agentsRoute(opts.db));
  await app.register(profileRoute(opts.db));
  await app.register(digestRoute(opts.db));
  await app.register(recallRoute(opts.db, config));
  await app.register(mcpRoute(opts.db, embed, config));
  await app.register(dashboardRoute(opts.db, config, opts.token, opts.healthState, devNoAuthActive));
  await app.register(dashboardConsolidationRoute(opts.db, opts.token, devNoAuthActive));
  await app.register(dashboardJobsRoute(opts.db, opts.token, devNoAuthActive));
  await app.register(dashboardLogsRoute(config.dataDir, opts.token, devNoAuthActive));
  await app.register(dashboardSearchRoute(opts.db, embed, opts.token, devNoAuthActive));
  await app.register(dashboardApiRoute(opts.token, devNoAuthActive));
  await app.register(dashboardProvidersRoute(config, opts.token, opts.healthState, devNoAuthActive));
  await app.register(memoryToolRoute(opts.db, config));
  await app.register(consolidationRoutes(opts.db, config));
  await app.register(entitiesRoute(opts.db));
  await app.register(syncStatusRoute(opts.db, config));

  return app;
}
