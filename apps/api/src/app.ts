import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Database } from './db/client';

export interface AppDeps {
  db: Database;
  logger?: boolean;
}

export function buildApp({ db, logger = false }: AppDeps): FastifyInstance {
  const app = Fastify({ logger });

  app.get('/api/salute', async () => {
    await db.execute(sql`select 1`);
    return { stato: 'ok' };
  });

  return app;
}
