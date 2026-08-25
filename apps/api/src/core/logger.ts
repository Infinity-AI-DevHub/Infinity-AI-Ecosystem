/**
 * Structured JSON logging (blueprint 15). Credentials, tokens, message bodies and
 * attachment content must never reach the log stream, so they are redacted here
 * rather than relying on every call site to remember.
 */
import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: { service: 'infinity-api', env: config.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-token"]',
      'res.headers["set-cookie"]',
      'password',
      'passwordHash',
      '*.password',
      '*.token',
      '*.tokenHash',
      '*.secret',
      '*.mfaSecret',
      '*.recoveryCodes',
      'body',
      'bodyHtml',
      'bodyText',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
