import path from 'node:path';
import type { Request, Response } from 'express';
import type { AppContext } from '../../app-context.js';
import { AppError, ValidationError } from '../../shared/errors/app-error.js';
import type { CaptureJobResult } from '../../modules/capture/capture.types.js';
import { parseCaptureJobRequest, parseReplayJobRequest, parseSweepJobRequest } from '../schemas/job-schemas.js';

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

    createCaptureJob: (request: Request, response: Response): void => {
      const payload = parseCaptureJobRequest(request.body);
      const job = context.jobManager.createJob({
        type: 'capture',
        lane: 'browser',
        inputPreview: payload,
        run: (jobContext) => context.captureService.execute(payload, jobContext),
      });

      response.status(202).json({
        job,
        note: 'Capture jobs stop after one valid selection and save a reusable payload. Use /api/v1/jobs/scrape for the full dataset.',
      });
    },

    createReplayJob: (request: Request, response: Response): void => {
      const payload = parseReplayJobRequest(request.body);
      const resolvedInput = payload.captureJobId
        ? resolveReplayInputFromCaptureJob(context, payload.captureJobId, payload)
        : {
            curlFilePath: path.resolve(payload.curlFile!),
            sourceDescription: 'request.curlFile',
            outputFileName: payload.outputFileName,
            maxPages: payload.maxPages,
            requestDelayMs: payload.requestDelayMs,
            applyFormOverrides: payload.applyFormOverrides,
          };

      const job = context.jobManager.createJob({
        type: 'replay',
        lane: 'replay',
        inputPreview: {
          ...payload,
          curlFile: resolvedInput.curlFilePath,
          sourceDescription: resolvedInput.sourceDescription,
        },
        run: (jobContext) => context.replayService.execute(resolvedInput, jobContext),
      });

      response.status(202).json({ job });
    },

    createSweepJob: (request: Request, response: Response): void => {
      const payload = parseSweepJobRequest(request.body);
      const job = context.jobManager.createJob({
        type: 'sweep',
        lane: 'browser',
        inputPreview: payload,
        run: (jobContext) => context.sweepService.execute(payload, jobContext),
      });

      response.status(202).json({ job });
    },

    createScrapeJob: (request: Request, response: Response): void => {
      const payload = parseSweepJobRequest(request.body);
      const job = context.jobManager.createJob({
        type: 'sweep',
        lane: 'browser',
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

function resolveReplayInputFromCaptureJob(
  context: AppContext,
  captureJobId: string,
  payload: ReturnType<typeof parseReplayJobRequest>
) {
  const captureJob = context.jobManager.getCompletedJob<CaptureJobResult>(captureJobId, 'capture');
  const selectedCurlPath = captureJob.result?.selectedCurlPath;

  if (!selectedCurlPath) {
    throw new ValidationError(`Capture job ${captureJobId} does not expose a selected curl artifact.`);
  }

  return {
    curlFilePath: selectedCurlPath,
    captureJobId,
    sourceDescription: `captureJob:${captureJobId}`,
    outputFileName: payload.outputFileName,
    maxPages: payload.maxPages,
    requestDelayMs: payload.requestDelayMs,
    applyFormOverrides: payload.applyFormOverrides,
  };
}
