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
