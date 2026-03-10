import { Router } from 'express';
import type { AppContext } from '../../app-context.js';
import { asyncHandler } from '../../shared/utils/async-handler.js';
import { createJobsController } from '../controllers/jobs.controller.js';

export function createJobRoutes(context: AppContext): Router {
  const router = Router();
  const controller = createJobsController(context);

  router.get('/health', asyncHandler(async (request, response) => controller.health(request, response)));
  router.get('/jobs', asyncHandler(async (request, response) => controller.listJobs(request, response)));
  router.post(
    '/jobs/capture',
    asyncHandler(async (request, response) => controller.createCaptureJob(request, response))
  );
  router.post(
    '/jobs/replay',
    asyncHandler(async (request, response) => controller.createReplayJob(request, response))
  );
  router.post(
    '/jobs/sweep',
    asyncHandler(async (request, response) => controller.createSweepJob(request, response))
  );
  router.post(
    '/jobs/scrape',
    asyncHandler(async (request, response) => controller.createScrapeJob(request, response))
  );
  router.get('/jobs/:jobId', asyncHandler(async (request, response) => controller.getJob(request, response)));
  router.get(
    '/jobs/:jobId/result',
    asyncHandler(async (request, response) => controller.getJobResult(request, response))
  );
  router.get(
    '/jobs/:jobId/artifacts',
    asyncHandler(async (request, response) => controller.getJobArtifacts(request, response))
  );

  return router;
}
