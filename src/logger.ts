import { mkdir, rename, stat, appendFile } from "node:fs/promises";
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

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function rotateIfNeeded(file: string, incomingBytes: number, maxFileBytes: number): Promise<void> {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    return;
  }
  if (size + incomingBytes <= maxFileBytes) return;
  for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    if (await pathExists(from)) await rename(from, to);
  }
  await rename(file, `${file}.1`);
}

async function writeIndependentLog(config: GraphMemoryIndependentLogConfig | undefined, level: GraphMemoryLogLevel, message: string): Promise<void> {
  if (config?.enabled === false) return;
  const file = resolveLogPath(config);
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message }) + "\n";
  await mkdir(dirname(file), { recursive: true });
  await rotateIfNeeded(file, Buffer.byteLength(line), resolveMaxFileBytes(config));
  await appendFile(file, line, "utf8");
}

export function createGraphMemoryLogger(host: HostLogger, config?: GraphMemoryIndependentLogConfig): GraphMemoryLogger {
  const fileEnabled = config?.enabled !== false;
  let writeQueue: Promise<void> = Promise.resolve();

  const enqueueFileWrite = (level: GraphMemoryLogLevel, message: string, fallback?: (message: string) => void) => {
    if (!fileEnabled) {
      fallback?.(message);
      return;
    }
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(() => writeIndependentLog(config, level, message))
      .catch(() => fallback?.(message));
  };

  const fileOnly = (level: GraphMemoryLogLevel, message: string, fallback: (message: string) => void) => {
    enqueueFileWrite(level, message, fallback);
  };
  const hostAndFile = (level: GraphMemoryLogLevel, message: string, emit: (message: string) => void) => {
    emit(message);
    enqueueFileWrite(level, message);
  };
  return {
    info: (message) => fileOnly("info", message, host.info),
    warn: (message) => hostAndFile("warn", message, host.warn),
    error: (message) => hostAndFile("error", message, host.error),
    debug: (message) => enqueueFileWrite("debug", message, host.debug),
    hostInfo: (message) => hostAndFile("info", message, host.info),
  };
}
