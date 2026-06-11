// Structured JSON logging via pino. Mirrors backend/app/logging_setup.py.
// In dev (ENVIRONMENT=dev) we pretty-print for readability; in prod we emit JSON
// so CloudWatch Logs Insights can query by field.

import pino from 'pino';
import { settings } from './config.js';

const isDev = settings.environment === 'dev';

const transport = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

export const logger = pino({
  level: settings.logLevel,
  transport,
  base: undefined, // drop pid/hostname noise
});

export function getLogger(name) {
  return logger.child({ logger: name });
}
