import type { Request, Response } from 'express';
import type { AppContext } from '../../app-context.js';
import { AppError } from '../../shared/errors/app-error.js';
import { parseSweepJobRequest } from '../schemas/job-schemas.js';

export function createJobsController(context: AppContext) {
  return {
    health: (_request: Request, response: Response): void => {
      response.json({
        status: 'ok',
        service: 'ssrs-price-costs-api',
        nodeEnv: context.env.nodeEnv,
        queue: context.env.queue,
        time: new Date().toISOString(),
      });
    },

    listJobs: (_request: Request, response: Response): void => {
      response.json({ jobs: context.jobManager.listJobs() });
    },

    createScrapeJob: (request: Request, response: Response): void => {
      const payload = parseSweepJobRequest(request.body);
      const job = context.jobManager.createJob({
        type: 'scrape',
        inputPreview: payload,
        run: (jobContext) => context.sweepService.execute(payload, jobContext),
      });

      response.status(202).json({
        job,
        note: 'This is the main full-data scrape job. It iterates stores, departments, subdepartments, commodities, and families.',
      });
    },

    getJob: (request: Request, response: Response): void => {
      response.json({ job: context.jobManager.getJob(readJobId(request)) });
    },

    getJobResult: (request: Request, response: Response): void => {
      const job = context.jobManager.getJob(readJobId(request));
      if (job.status !== 'completed') {
        throw new AppError({
          message: `Job ${job.id} is not completed yet. Current status: ${job.status}.`,
          statusCode: 409,
          code: 'JOB_NOT_COMPLETED',
          expose: true,
        });
      }

      response.json({
        jobId: job.id,
        type: job.type,
        result: job.result,
      });
    },

    getJobArtifacts: (request: Request, response: Response): void => {
      const job = context.jobManager.getJob(readJobId(request));
      response.json({
        jobId: job.id,
        type: job.type,
        artifacts: job.artifacts,
      });
    },
  };
}

function readJobId(request: Request): string {
  return String(request.params['jobId'] || '').trim();
}
