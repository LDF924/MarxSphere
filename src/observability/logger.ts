import pino from "pino";
import { config } from "../config/env.js";
import { sanitizeLine, sanitizeObject } from "../services/log-sanitizer.js";

const loggerOptions = {
  level: config.LOG_LEVEL,
  base: {
    service: "marxsphere"
  },
};

// V310(P0-15): 日志脱敏 — 所有日志输出统一走 sanitize（PII 不进系统日志）
// 脱敏不改动入库数据本身，只改日志可读层
const rawLogger = process.env.SAG_LOG_STDERR === "true"
  ? pino(loggerOptions, pino.destination(2))
  : pino(loggerOptions);

// 包装: 对 msg 和对象字段做脱敏
function wrapLog(obj: unknown, msg?: string): [unknown, string?] {
  if (msg) return [sanitizeObject(obj), sanitizeLine(msg)];
  return [sanitizeObject(obj)];
}

export const logger = {
  info: (obj: unknown, msg?: string) => {
    const [o, m] = wrapLog(obj, msg);
    rawLogger.info(o, m ?? "");
  },
  warn: (obj: unknown, msg?: string) => {
    const [o, m] = wrapLog(obj, msg);
    rawLogger.warn(o, m ?? "");
  },
  error: (obj: unknown, msg?: string) => {
    const [o, m] = wrapLog(obj, msg);
    rawLogger.error(o, m ?? "");
  },
  debug: (obj: unknown, msg?: string) => {
    const [o, m] = wrapLog(obj, msg);
    rawLogger.debug(o, m ?? "");
  },
  fatal: (obj: unknown, msg?: string) => {
    const [o, m] = wrapLog(obj, msg);
    rawLogger.fatal(o, m ?? "");
  },
};
