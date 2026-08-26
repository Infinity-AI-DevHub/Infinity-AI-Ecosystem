/**
 * Standalone worker process.
 *
 * Run this alongside the API when workers should scale independently of request
 * traffic (`WORKERS_ENABLED=false` on the API instances).
 */
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { closePool, pool } from '../core/db.js';
import { startDispatcher, stopDispatcher } from './dispatcher.js';
import { startScheduler, stopScheduler } from './scheduler.js';

async function main(): Promise<void> {
  await pool.query('SELECT 1');
  startDispatcher();
  startScheduler();
  logger.info({ env: config.env }, 'Infinity Workspace worker started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    stopDispatcher();
    stopScheduler();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
