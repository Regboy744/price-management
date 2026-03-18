import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_CONSOLE_LOG_LEVEL: LogLevel = 'info';

export interface Logger {
  debug: (message: string, metadata?: Record<string, unknown>) => void;
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
  writeToFiles: (level: LogLevel, message: string, metadata?: Record<string, unknown>) => void;
  child: (context: Record<string, unknown>, logFilePath?: string) => Logger;
}

interface LogSink {
  write: (level: LogLevel, line: string) => void;
}

function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }

  return fallback;
}

function readConsoleLogLevel(): LogLevel {
  return parseLogLevel(process.env['LOG_CONSOLE_LEVEL'], DEFAULT_CONSOLE_LOG_LEVEL);
}

function shouldWriteLevel(level: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[threshold];
}

function createConsoleSink(level: LogLevel): LogSink {
  return {
    write: (_entryLevel: LogLevel, line: string): void => {
      if (level === 'error') {
        console.error(line);
        return;
      }

      if (level === 'warn') {
        console.warn(line);
        return;
      }

      console.log(line);
    },
  };
}

function createFileSink(logFilePath: string): LogSink {
  ensureParentDirectory(logFilePath);
  const stream = fs.createWriteStream(logFilePath, {
    flags: 'a',
    encoding: 'utf8',
  });

  return {
    write: (_level: LogLevel, line: string): void => {
      stream.write(`${line}\n`);
    },
  };
}

function createLevelFileSink(logFilePath: string, allowedLevel: LogLevel): LogSink {
  const stream = fs.createWriteStream(logFilePath, {
    flags: 'a',
    encoding: 'utf8',
  });

  return {
    write: (level: LogLevel, line: string): void => {
      if (level !== allowedLevel) {
        return;
      }

      stream.write(`${line}\n`);
    },
  };
}

function createJobFileSinks(logFilePath: string): LogSink[] {
  const logsDirectory = path.join(path.dirname(logFilePath), 'logs');
  ensureParentDirectory(logFilePath);
  fs.mkdirSync(logsDirectory, { recursive: true });

  return [
    createFileSink(logFilePath),
    createLevelFileSink(path.join(logsDirectory, 'debug.log'), 'debug'),
    createLevelFileSink(path.join(logsDirectory, 'info.log'), 'info'),
    createLevelFileSink(path.join(logsDirectory, 'warn.log'), 'warn'),
    createLevelFileSink(path.join(logsDirectory, 'error.log'), 'error'),
  ];
}

function serializeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
  if (!metadata) {
    return {};
  }

  const serialized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value instanceof Error) {
      serialized[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
      continue;
    }

    serialized[key] = value;
  }

  return serialized;
}

class StructuredLogger implements Logger {
  constructor(
    private readonly context: Record<string, unknown>,
    private readonly fileSinks: LogSink[] = []
  ) {}

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.write('debug', message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.write('info', message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.write('warn', message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.write('error', message, metadata);
  }

  writeToFiles(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    this.write(level, message, metadata, false);
  }

  child(context: Record<string, unknown>, logFilePath?: string): Logger {
    const sinks = [...this.fileSinks];

    if (logFilePath) {
      sinks.push(...createJobFileSinks(logFilePath));
    }

    return new StructuredLogger({ ...this.context, ...context }, sinks);
  }

  private write(
    level: LogLevel,
    message: string,
    metadata?: Record<string, unknown>,
    includeConsole = true
  ): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.context,
      ...serializeMetadata(metadata),
    };
    const line = JSON.stringify(entry);

    if (includeConsole && shouldWriteLevel(level, readConsoleLogLevel())) {
      createConsoleSink(level).write(level, line);
    }

    for (const sink of this.fileSinks) {
      sink.write(level, line);
    }
  }
}

export function createLogger(
  context: Record<string, unknown> = {},
  logFilePath?: string
): Logger {
  const sinks = logFilePath ? createJobFileSinks(logFilePath) : [];
  return new StructuredLogger(context, sinks);
}
