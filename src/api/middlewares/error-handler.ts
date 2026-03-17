import type { ErrorRequestHandler } from 'express';
import type { Logger } from '../../config/logger.js';
import {
  AppError,
  getPublicErrorMessage,
  toAppError,
} from '../../shared/errors/app-error.js';

function normalizeRequestError(error: unknown): AppError {
  if (error instanceof SyntaxError && error.message.toLowerCase().includes('json')) {
    return new AppError({
      message: 'Invalid JSON request body.',
      statusCode: 400,
      code: 'INVALID_JSON',
      expose: true,
    });
  }

  return toAppError(error);
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    const appError = normalizeRequestError(error);
    const requestId = response.locals['requestId'];

    logger.error('Request failed', {
      requestId,
      method: request.method,
      path: request.originalUrl,
      statusCode: appError.statusCode,
      error,
    });

    response.status(appError.statusCode).json({
      error: {
        code: appError.code,
        message: getPublicErrorMessage(appError),
        details: appError.expose ? appError.details : undefined,
        requestId,
      },
    });
  };
}
