import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../storage/db.js';
import { healthRoute } from './routes/health.js';
import { ingestRoute } from './routes/ingest.js';

export interface AppOpts {
  db: DB;
  token: string;
}

export async function buildApp(opts: AppOpts): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health') return;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${opts.token}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  await app.register(healthRoute);
  await app.register(ingestRoute(opts.db));

  return app;
}
