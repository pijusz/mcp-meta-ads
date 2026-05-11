const PREFIX = "[mcp-meta-ads]";

type Level = "error" | "warn" | "info" | "debug";

const LEVELS: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevel(): Level {
  const raw = (process.env.META_ADS_LOG_LEVEL ?? "warn").toLowerCase();
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug") {
    return raw;
  }
  return "warn";
}

function shouldLog(level: Level): boolean {
  return LEVELS[level] <= LEVELS[currentLevel()];
}

export const log = {
  info: (...args: unknown[]) => {
    if (shouldLog("info")) console.error(PREFIX, ...args);
  },
  warn: (...args: unknown[]) => {
    if (shouldLog("warn")) console.error(PREFIX, "WARN", ...args);
  },
  error: (...args: unknown[]) => {
    if (shouldLog("error")) console.error(PREFIX, "ERROR", ...args);
  },
  debug: (...args: unknown[]) => {
    if (shouldLog("debug")) console.error(PREFIX, "DEBUG", ...args);
  },
};
