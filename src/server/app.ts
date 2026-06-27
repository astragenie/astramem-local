import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../storage/db.js';
import type { EmbedProvider } from '../contracts/index.js';
import { healthRoute } from './routes/health.js';
import { ingestRoute } from './routes/ingest.js';
import { searchRoute } from './routes/search.js';
import { memoryRoute } from './routes/memory.js';
import { makeFakeVec } from '../search/search.js';

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
  const app = Fastify({ logger: false });
  const embed = opts.embed ?? makeNoopEmbed();

  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health') return;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${opts.token}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  await app.register(healthRoute);
  await app.register(ingestRoute(opts.db));
  await app.register(searchRoute(opts.db, embed));
  await app.register(memoryRoute(opts.db));

  return app;
}
