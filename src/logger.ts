/** Minimal leveled logger. Everything goes to stderr so stdio transport stays clean. */

const LEVELS: Record<string, number> = { DEBUG: 10, INFO: 20, WARNING: 30, WARN: 30, ERROR: 40 };

import { config } from "./config";

function currentLevel(): number {
  return LEVELS[config.logLevel] ?? LEVELS.INFO;
}

function stamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function emit(level: string, scope: string, args: unknown[]): void {
  if ((LEVELS[level] ?? 20) < currentLevel()) return;
  const text = args
    .map((a) => (typeof a === "string" ? a : safeStringify(a)))
    .join(" ");
  process.stderr.write(`${stamp()} ${level} [${scope}] ${text}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => emit("DEBUG", scope, args),
    info: (...args: unknown[]) => emit("INFO", scope, args),
    warn: (...args: unknown[]) => emit("WARNING", scope, args),
    error: (...args: unknown[]) => emit("ERROR", scope, args),
  };
}

export const log = createLogger("binance-mcp");
