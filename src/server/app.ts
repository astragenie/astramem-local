import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../storage/db.js';
import type { EmbedProvider } from '../contracts/index.js';
import { healthRoute } from './routes/health.js';
import { versionRoute } from './routes/version.js';
import { ingestRoute } from './routes/ingest.js';
import { searchRoute } from './routes/search.js';
import { memoryRoute } from './routes/memory.js';
import { whyRoute } from './routes/why.js';
import { digestRoute } from './routes/digest.js';
import { recallRoute } from './routes/recall.js';
import { mcpRoute } from './routes/mcp.js';
import { makeFakeVec } from '../search/search.js';
import { childLogger } from '../log/logger.js';
import { newRequestId, runWithRequestId } from '../log/correlation.js';

/** Default no-op embed provider used when no real provider is injected. */
function makeNoopEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'noop',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: false, model: 'noop', dim: 1024 as const, error: 'no provider configured' })
  };
}

export interface AppOpts {
  db: DB;
  token: string;
  /** Embed provider injected for search + remember routes. Defaults to fake/noop. */
  embed?: EmbedProvider;
}

export async function buildApp(opts: AppOpts): Promise<FastifyInstance> {
  // Fastify's internal logger is disabled. We emit request lifecycle logs
  // manually via the onResponse hook below, using our pino instance + the
  // request_id we generate in onRequest. This sidesteps a type incompatibility
  // between FastifyBaseLogger and FastifyInstance<never logger>.
  const app = Fastify({ logger: false });
  const embed = opts.embed ?? makeNoopEmbed();

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
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health' || req.url === '/version') return;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${opts.token}`) {
      const requestId = (req as unknown as Record<string, unknown>)['requestId'] as string | undefined;
      childLogger({ request_id: requestId ?? 'unknown' }).warn(
        { method: req.method, path: req.url },
        'unauthorized request',
      );
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  await app.register(healthRoute);
  await app.register(versionRoute);
  await app.register(ingestRoute(opts.db));
  await app.register(searchRoute(opts.db, embed));
  await app.register(memoryRoute(opts.db));
  await app.register(whyRoute(opts.db));
  await app.register(digestRoute(opts.db));
  await app.register(recallRoute(opts.db));
  await app.register(mcpRoute(opts.db, embed));

  return app;
}
