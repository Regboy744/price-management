export interface AppErrorOptions {
  message: string;
  statusCode?: number;
  code?: string;
  details?: unknown;
  expose?: boolean;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = 'AppError';
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'APP_ERROR';
    this.details = options.details;
    this.expose = options.expose ?? this.statusCode < 500;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super({
      message,
      details,
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      expose: true,
    });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super({
      message,
      details,
      statusCode: 404,
      code: 'NOT_FOUND',
      expose: true,
    });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super({
      message,
      details,
      statusCode: 409,
      code: 'CONFLICT',
      expose: true,
    });
    this.name = 'ConflictError';
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError({
      message: error.message,
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      expose: false,
    });
  }

  return new AppError({
    message: String(error),
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    expose: false,
  });
}
