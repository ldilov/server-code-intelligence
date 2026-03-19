import pino from "pino";
export function createLogger(options) {
    return pino({
        name: "local-engineering-brain",
        level: process.env.LEB_LOG_LEVEL ?? "info",
        ...options
    });
}
//# sourceMappingURL=logger.js.map