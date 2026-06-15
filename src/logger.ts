import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export type GraphMemoryLogLevel = "info" | "warn" | "error" | "debug";

export interface GraphMemoryIndependentLogConfig {
  enabled?: boolean;
  file?: string;
  maxFileBytes?: number;
}

export interface GraphMemoryLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
  hostInfo(message: string): void;
}

type HostLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?: (message: string) => void;
};

const DEFAULT_MAX_FILE_BYTES = 104_857_600;
const MAX_ROTATED_FILES = 5;

function defaultLogPath(now = new Date()): string {
  return join("/tmp/openclaw", `graph-memory-${now.toISOString().slice(0, 10)}.log`);
}

function resolveLogPath(config?: GraphMemoryIndependentLogConfig): string {
  const configured = typeof config?.file === "string" ? config.file.trim() : "";
  return configured || defaultLogPath();
}

function resolveMaxFileBytes(config?: GraphMemoryIndependentLogConfig): number {
  const value = config?.maxFileBytes;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAX_FILE_BYTES;
}

function rotateIfNeeded(file: string, incomingBytes: number, maxFileBytes: number): void {
  if (!existsSync(file)) return;
  const size = statSync(file).size;
  if (size + incomingBytes <= maxFileBytes) return;
  for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    if (existsSync(from)) renameSync(from, to);
  }
  renameSync(file, `${file}.1`);
}

function writeIndependentLog(config: GraphMemoryIndependentLogConfig | undefined, level: GraphMemoryLogLevel, message: string): boolean {
  if (config?.enabled === false) return false;
  const file = resolveLogPath(config);
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message }) + "\n";
  try {
    mkdirSync(dirname(file), { recursive: true });
    rotateIfNeeded(file, Buffer.byteLength(line), resolveMaxFileBytes(config));
    appendFileSync(file, line, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function createGraphMemoryLogger(host: HostLogger, config?: GraphMemoryIndependentLogConfig): GraphMemoryLogger {
  const fileEnabled = config?.enabled !== false;
  const fileOnly = (level: GraphMemoryLogLevel, message: string, fallback: (message: string) => void) => {
    if (!fileEnabled || !writeIndependentLog(config, level, message)) fallback(message);
  };
  const hostAndFile = (level: GraphMemoryLogLevel, message: string, emit: (message: string) => void) => {
    emit(message);
    if (fileEnabled) writeIndependentLog(config, level, message);
  };
  return {
    info: (message) => fileOnly("info", message, host.info),
    warn: (message) => hostAndFile("warn", message, host.warn),
    error: (message) => hostAndFile("error", message, host.error),
    debug: (message) => {
      if (fileEnabled) {
        if (!writeIndependentLog(config, "debug", message)) host.debug?.(message);
      } else {
        host.debug?.(message);
      }
    },
    hostInfo: (message) => hostAndFile("info", message, host.info),
  };
}
