/**
 * Outbox dispatcher (blueprint 06).
 *
 * Claims committed domain events and runs their handlers. Handlers must be idempotent:
 * an event can be delivered more than once after a crash or a timeout, and retries use
 * exponential backoff before a permanently failing event lands in dead letters.
 */
import { claimBatch, markFailed, markProcessed, type StoredEvent } from '../core/outbox.js';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { handlers } from './handlers.js';

let running = false;
let timer: NodeJS.Timeout | null = null;

async function processEvent(event: StoredEvent): Promise<void> {
  const handler = handlers[event.type];
  if (!handler) {
    // An unknown type is not an error: a newer instance may own it, or it may be
    // informational. It is acknowledged so the queue cannot stall.
    logger.debug({ type: event.type, id: event.id }, 'no handler for event type');
    await markProcessed(event.id);
    return;
  }
  try {
    await handler(event);
    await markProcessed(event.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, type: event.type, id: event.id, attempts: event.attempts }, 'event handler failed');
    await markFailed(event, message, config.jobs.maxAttempts);
  }
}

async function tick(): Promise<void> {
  const batch = await claimBatch(config.jobs.batchSize);
  if (batch.length === 0) return;
  // Sequential processing keeps per-company ordering predictable and bounds database load.
  for (const event of batch) {
    await processEvent(event);
  }
}

export function startDispatcher(): void {
  if (running) return;
  running = true;
  logger.info({ batchSize: config.jobs.batchSize }, 'outbox dispatcher started');

  const loop = async () => {
    if (!running) return;
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, 'dispatcher tick failed');
    }
    if (running) timer = setTimeout(loop, config.jobs.pollIntervalMs);
  };
  void loop();
}

export function stopDispatcher(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  logger.info('outbox dispatcher stopped');
}

/** Drains the queue once. Used by tests and by the one-shot worker CLI. */
export async function drain(maxIterations = 50): Promise<number> {
  let processed = 0;
  for (let i = 0; i < maxIterations; i += 1) {
    const batch = await claimBatch(config.jobs.batchSize);
    if (batch.length === 0) break;
    for (const event of batch) {
      await processEvent(event);
      processed += 1;
    }
  }
  return processed;
}
