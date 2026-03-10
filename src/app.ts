import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { AppContext } from './app-context.js';
import { createApiRouter } from './api/routes/index.js';
import { appEnvironment, type AppEnvironment } from './config/env.js';
import { createLogger } from './config/logger.js';
import { CaptureService } from './modules/capture/capture.service.js';
import { JobManager } from './modules/jobs/job-manager.js';
import { ReplayService } from './modules/replay/replay.service.js';
import { SweepService } from './modules/sweep/sweep.service.js';
import { createErrorHandler } from './api/middlewares/error-handler.js';

export function createAppContext(env: AppEnvironment = appEnvironment): AppContext {
  const logger = createLogger({ service: 'ssrs-price-costs-api', env: env.nodeEnv });
  const jobManager = new JobManager({
    jobsRootDir: env.storage.jobsRootDir,
    browserConcurrency: env.queue.browserConcurrency,
    replayConcurrency: env.queue.replayConcurrency,
    logger,
  });

  return {
    env,
    logger,
    jobManager,
    captureService: new CaptureService(env),
    replayService: new ReplayService(env),
    sweepService: new SweepService(env),
  };
}

export function createApp(context: AppContext = createAppContext()): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = randomUUID();
    const startedAt = Date.now();

    response.locals['requestId'] = requestId;
    response.setHeader('x-request-id', requestId);

    response.on('finish', () => {
      context.logger.info('Request completed', {
        requestId,
        method: request.method,
        path: request.originalUrl,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    next();
  });

  app.use('/api/v1', createApiRouter(context));
  app.use(createErrorHandler(context.logger));

  return app;
}
