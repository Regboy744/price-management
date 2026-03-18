import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

import type { LogLevel, Logger } from './config/logger.js';

type RuntimeLogLevel = LogLevel;

const LOG_LEVEL_ORDER: Record<RuntimeLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_CONSOLE_LEVEL: RuntimeLogLevel = 'warn';
const DEFAULT_FILE_LEVEL: RuntimeLogLevel = 'debug';

const runtimeLoggerStorage = new AsyncLocalStorage<Logger>();

let fileStream: fs.WriteStream | null = null;

export async function runWithRuntimeLogger<T>(logger: Logger, callback: () => Promise<T>): Promise<T> {
  return runtimeLoggerStorage.run(logger, callback);
}

function parseLogLevel(value: string | undefined, fallback: RuntimeLogLevel): RuntimeLogLevel {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }

  return fallback;
}

function readLogFilePath(): string | null {
  const raw = String(process.env['SCRAPE_LOG_FILE'] || '').trim();
  if (!raw) {
    return null;
  }

  return path.resolve(raw);
}

function getConsoleLevel(): RuntimeLogLevel {
  return parseLogLevel(process.env['SCRAPE_LOG_LEVEL'], DEFAULT_CONSOLE_LEVEL);
}

function getFileLevel(): RuntimeLogLevel {
  return parseLogLevel(process.env['SCRAPE_FILE_LOG_LEVEL'], DEFAULT_FILE_LEVEL);
}

function shouldWrite(level: RuntimeLogLevel, threshold: RuntimeLogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[threshold];
}

function formatLine(level: RuntimeLogLevel, message: string): string {
  return `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
}

function getFileStream(): fs.WriteStream | null {
  const filePath = readLogFilePath();
  if (!filePath) {
    return null;
  }

  if (!fileStream) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fileStream = fs.createWriteStream(filePath, {
      flags: 'a',
      encoding: 'utf8',
    });
  }

  return fileStream;
}

function writeRuntimeLog(level: RuntimeLogLevel, message: string): void {
  const line = formatLine(level, message);
  const activeLogger = runtimeLoggerStorage.getStore();

  if (shouldWrite(level, getConsoleLevel())) {
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  if (activeLogger) {
    activeLogger.writeToFiles(level, message, { source: 'runtime' });
    return;
  }

  if (shouldWrite(level, getFileLevel())) {
    const stream = getFileStream();
    stream?.write(`${line}\n`);
  }
}

export function logDebug(message: string): void {
  writeRuntimeLog('debug', message);
}

export function logInfo(message: string): void {
  writeRuntimeLog('info', message);
}

export function logWarn(message: string): void {
  writeRuntimeLog('warn', message);
}

export function logError(message: string): void {
  writeRuntimeLog('error', message);
}
