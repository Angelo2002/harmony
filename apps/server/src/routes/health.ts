import type { FastifyInstance } from 'fastify';
import { API_VERSION, GATEWAY_VERSION, HARMONY_NAME } from '@harmony/shared';
import type { Database } from '../db/index.ts';

export function registerHealthRoutes(app: FastifyInstance, db: Database): void {
  app.get('/api/v1/health', async () => {
    let database: 'ok' | 'error' = 'ok';
    try {
      db.sqlite.prepare('SELECT 1').get();
    } catch {
      database = 'error';
    }

    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      name: HARMONY_NAME,
      apiVersion: API_VERSION,
      gatewayVersion: GATEWAY_VERSION,
      database,
      uptimeSeconds: Math.round(process.uptime()),
    };
  });
}
