/**
 * Route registration. Everything user-facing lives under /api/v1; health and readiness
 * are unversioned so orchestrators can rely on a stable path.
 */
import type { FastifyInstance } from 'fastify';
import { pool } from '../../core/db.js';
import { config } from '../../core/config.js';
import { authRoutes } from './auth.js';
import { meRoutes } from './me.js';
import { userRoutes } from './users.js';
import {
  announcementRoutes,
  approvalRoutes,
  calendarRoutes,
  chatRoutes,
  fileRoutes,
  searchRoutes,
  taskRoutes,
} from './collaboration.js';
import { adminRoutes, objectRoutes } from './admin.js';
import { externalRoutes, publicShareRoutes } from './external.js';
import { leaveRoutes } from './leave.js';
import { documentRoutes } from './documents.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness: the process is up. Never touches the database. */
  app.get('/health', async () => ({ status: 'ok', version: '1.0.0', env: config.env }));

  /** Readiness: dependencies the instance needs before it should receive traffic. */
  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'failed'> = {};
    try {
      await pool.query('SELECT 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'failed';
    }
    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'degraded', checks });
  });

  await app.register(
    async (api) => {
      await authRoutes(api);
      await meRoutes(api);
      await userRoutes(api);
      await calendarRoutes(api);
      await chatRoutes(api);
      await taskRoutes(api);
      await fileRoutes(api);
      await approvalRoutes(api);
      await announcementRoutes(api);
      await searchRoutes(api);
      await adminRoutes(api);
      await objectRoutes(api);
      await externalRoutes(api);
      await leaveRoutes(api);
      await documentRoutes(api);
      // Anonymous by design: the token in the URL is the whole credential. Registered
      // last and named separately so the authenticated surface above stays obvious.
      await publicShareRoutes(api);
    },
    { prefix: '/api/v1' },
  );
}
