export function envBool(value: string | undefined | null, defaultValue = false): boolean {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TimedActionError extends Error {
  readonly action: string;
  readonly timeoutMs: number;

  constructor(action: string, timeoutMs: number) {
    super(`${action} timed out after ${timeoutMs}ms`);
    this.name = 'TimedActionError';
    this.action = action;
    this.timeoutMs = timeoutMs;
  }
}

interface ErrorWithCode extends Error {
  code?: string;
}

function hasErrorCode(error: Error): error is ErrorWithCode {
  return 'code' in error;
}

export class OperationAbortedError extends Error {
  readonly reason: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'OperationAbortedError';
    this.reason = reason;
  }
}

export function toAbortError(
  reason: unknown,
  fallbackMessage = 'Operation aborted'
): OperationAbortedError {
  if (reason instanceof OperationAbortedError) {
    return reason;
  }

  if (reason instanceof Error) {
    return new OperationAbortedError(reason.message || fallbackMessage, reason);
  }

  if (typeof reason === 'string' && reason.trim().length > 0) {
    return new OperationAbortedError(reason, reason);
  }

  return new OperationAbortedError(fallbackMessage, reason);
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof OperationAbortedError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === 'AbortError' ||
    error.name === 'CanceledError' ||
    (hasErrorCode(error) && error.code === 'ERR_CANCELED')
  );
}

export function throwIfAborted(
  signal?: AbortSignal,
  fallbackMessage = 'Operation aborted'
): void {
  if (!signal?.aborted) {
    return;
  }

  throw toAbortError(signal.reason, fallbackMessage);
}

export async function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
  fallbackMessage = 'Operation aborted'
): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal, fallbackMessage);
    return;
  }

  throwIfAborted(signal, fallbackMessage);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(toAbortError(signal?.reason, fallbackMessage));
    };

    timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });

    if (signal?.aborted) {
      onAbort();
    }
  });
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  createError: () => Error
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation;
  }

  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(createError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function resolveBrowserActionTimeoutMs(options: {
  browserActionTimeoutMs: number;
  selectPostbackTimeoutMs: number;
  preferredCaptureTimeoutMs: number;
  renderTimeoutMs: number;
}): number {
  const configured = Math.max(0, Math.floor(Number(options.browserActionTimeoutMs) || 0));
  if (configured > 0) {
    return configured;
  }

  return Math.max(
    10_000,
    Math.floor(Number(options.selectPostbackTimeoutMs) || 0) + 2_000,
    Math.floor(Number(options.preferredCaptureTimeoutMs) || 0) + 2_000,
    Math.min(20_000, Math.floor(Number(options.renderTimeoutMs) || 0))
  );
}

export function sanitizeToken(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function shellSingleQuote(value: string): string {
  return `'${String(value || '').replace(/'/g, `'"'"'`)}'`;
}
