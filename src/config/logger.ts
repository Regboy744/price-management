import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug: (message: string, metadata?: Record<string, unknown>) => void;
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
  child: (context: Record<string, unknown>, logFilePath?: string) => Logger;
}

interface LogSink {
  write: (line: string) => void;
}

function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function createConsoleSink(level: LogLevel): LogSink {
  return {
    write: (line: string): void => {
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

  return {
    write: (line: string): void => {
      fs.appendFileSync(logFilePath, `${line}\n`, 'utf8');
    },
  };
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

  child(context: Record<string, unknown>, logFilePath?: string): Logger {
    const sinks = [...this.fileSinks];

    if (logFilePath) {
      sinks.push(createFileSink(logFilePath));
    }

    return new StructuredLogger({ ...this.context, ...context }, sinks);
  }

  private write(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.context,
      ...serializeMetadata(metadata),
    };
    const line = JSON.stringify(entry);

    createConsoleSink(level).write(line);
    for (const sink of this.fileSinks) {
      sink.write(line);
    }
  }
}

export function createLogger(
  context: Record<string, unknown> = {},
  logFilePath?: string
): Logger {
  const sinks = logFilePath ? [createFileSink(logFilePath)] : [];
  return new StructuredLogger(context, sinks);
}
