/**
 * Process entrypoint.
 *
 * Starts the HTTP server, and - unless workers are run as a separate deployment - the
 * outbox dispatcher and scheduler. Shutdown is graceful: the listener stops accepting
 * new connections, in-flight requests finish, workers stop, then the pool closes.
 */
import { buildServer } from './http/server.js';
import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { closePool, pool } from './core/db.js';
import { startDispatcher, stopDispatcher } from './workers/dispatcher.js';
import { startScheduler, stopScheduler } from './workers/scheduler.js';

async function main(): Promise<void> {
  // Fail fast and loudly if the database is unreachable at boot.
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    logger.error({ err }, 'cannot reach the database; refusing to start');
    process.exit(1);
  }

  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });

  if (config.jobs.enabled) {
    startDispatcher();
    startScheduler();
  } else {
    logger.info('workers disabled in this process (WORKERS_ENABLED=false)');
  }

  logger.info(
    {
      port: config.port,
      env: config.env,
      providers: {
        mail: config.mail.driver,
        storage: config.storage.driver,
        meetings: config.meetings.provider,
      },
    },
    'Infinity Workspace API is listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // If shutdown stalls, exit anyway rather than hanging the orchestrator.
    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out; exiting');
      process.exit(1);
    }, 20_000);
    forceExit.unref();

    try {
      stopDispatcher();
      stopScheduler();
      await app.close();
      await closePool();
      clearTimeout(forceExit);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    // An uncaught exception leaves the process in an unknown state; restart cleanly.
    logger.fatal({ err }, 'uncaught exception; terminating');
    void shutdown('uncaughtException');
  });
}

void main();
