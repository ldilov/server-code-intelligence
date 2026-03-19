import pino, { type Logger, type LoggerOptions } from "pino";

export function createLogger(options?: LoggerOptions): Logger {
  return pino({
    name: "local-engineering-brain",
    level: process.env.LEB_LOG_LEVEL ?? "info",
    ...options
  });
}
