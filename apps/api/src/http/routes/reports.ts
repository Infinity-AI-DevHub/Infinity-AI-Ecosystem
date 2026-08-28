/**
 * Reporting routes. Every one is gated on report.read, which until now was granted and
 * never checked.
 */
import type { FastifyInstance } from 'fastify';
import * as reports from '../../domains/reports.js';
import { requireActor } from '../context.js';

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reports/overview', async (request) => reports.overview(requireActor(request)));
  app.get('/reports/headcount', async (request) => reports.headcount(requireActor(request)));
  app.get('/reports/approvals', async (request) => reports.approvals(requireActor(request)));
  app.get('/reports/spend', async (request) => reports.spend(requireActor(request)));
  app.get('/reports/leave', async (request) => reports.leave(requireActor(request)));
  app.get('/reports/assets', async (request) => reports.assets(requireActor(request)));
}
