import type { UmgConfig } from "../config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let current: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function configureLogging(cfg: UmgConfig): void {
  setLogLevel(cfg.log_level);
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[current];
}

/** All logs go to stderr so MCP stdio stdout stays pure JSON-RPC. */
function write(level: LogLevel, msg: string, extra?: unknown): void {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const line =
    extra === undefined
      ? `[umg ${ts}] ${level.toUpperCase()} ${msg}`
      : `[umg ${ts}] ${level.toUpperCase()} ${msg} ${safeJson(extra)}`;
  process.stderr.write(line + "\n");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => write("debug", msg, extra),
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
};
