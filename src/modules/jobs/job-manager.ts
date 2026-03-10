import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../../config/logger.js';
import { listFilesRecursively, resolveJobDirectory } from '../../config/paths.js';
import { AppError, NotFoundError, toAppError } from '../../shared/errors/app-error.js';
import { redactSensitiveData } from '../../shared/utils/redact.js';
import type {
  CreateJobRequest,
  JobArtifacts,
  JobErrorSummary,
  JobLane,
  JobRunnerContext,
  JobStatus,
  JobSummary,
  JobType,
} from './job.types.js';

interface LaneState {
  activeCount: number;
  concurrency: number;
  queue: string[];
}

interface InternalJobRecord<TResult = unknown> extends JobSummary<TResult> {
  run: (context: JobRunnerContext) => Promise<TResult>;
}

export interface JobManagerOptions {
  jobsRootDir: string;
  browserConcurrency: number;
  replayConcurrency: number;
  logger: Logger;
}

export class JobManager {
  private readonly jobs = new Map<string, InternalJobRecord>();
  private readonly lanes = new Map<JobLane, LaneState>();

  constructor(private readonly options: JobManagerOptions) {
    fs.mkdirSync(options.jobsRootDir, { recursive: true });

    this.lanes.set('browser', {
      activeCount: 0,
      concurrency: Math.max(1, options.browserConcurrency),
      queue: [],
    });

    this.lanes.set('replay', {
      activeCount: 0,
      concurrency: Math.max(1, options.replayConcurrency),
      queue: [],
    });
  }

  createJob<TInput, TResult>(request: CreateJobRequest<TInput, TResult>): JobSummary<TResult> {
    const jobId = randomUUID();
    const jobDirectory = resolveJobDirectory(this.options.jobsRootDir, jobId);
    const logPath = path.join(jobDirectory, 'job.log');
    const snapshotPath = path.join(jobDirectory, 'job.json');

    fs.mkdirSync(jobDirectory, { recursive: true });

    const record: InternalJobRecord<TResult> = {
      id: jobId,
      type: request.type,
      lane: request.lane,
      status: 'queued',
      createdAt: new Date().toISOString(),
      input: redactSensitiveData(request.inputPreview),
      artifacts: {
        jobDirectory,
        snapshotPath,
        logPath,
        files: [],
      },
      run: request.run,
    };

    this.jobs.set(jobId, record as InternalJobRecord);
    this.persist(record);
    this.enqueue(record);

    return this.toPublicRecord(record);
  }

  listJobs(): JobSummary[] {
    return Array.from(this.jobs.values())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record) => this.toPublicRecord(record));
  }

  getJob(jobId: string): JobSummary {
    const record = this.jobs.get(jobId);
    if (!record) {
      throw new NotFoundError(`Job not found: ${jobId}`);
    }

    return this.toPublicRecord(record);
  }

  getCompletedJob<TResult>(jobId: string, expectedType?: JobType): JobSummary<TResult> {
    const job = this.getJob(jobId) as JobSummary<TResult>;

    if (expectedType && job.type !== expectedType) {
      throw new AppError({
        message: `Job ${jobId} is not a ${expectedType} job.`,
        statusCode: 400,
        code: 'INVALID_JOB_TYPE',
        expose: true,
      });
    }

    if (job.status !== 'completed') {
      throw new AppError({
        message: `Job ${jobId} is not completed yet. Current status: ${job.status}.`,
        statusCode: 409,
        code: 'JOB_NOT_COMPLETED',
        expose: true,
      });
    }

    return job;
  }

  private enqueue(record: InternalJobRecord): void {
    const lane = this.lanes.get(record.lane);
    if (!lane) {
      throw new Error(`Unknown job lane: ${record.lane}`);
    }

    lane.queue.push(record.id);
    this.drainLane(record.lane);
  }

  private drainLane(laneName: JobLane): void {
    const lane = this.lanes.get(laneName);
    if (!lane) {
      return;
    }

    while (lane.activeCount < lane.concurrency && lane.queue.length > 0) {
      const jobId = lane.queue.shift()!;
      const record = this.jobs.get(jobId);

      if (!record) {
        continue;
      }

      lane.activeCount += 1;
      void this.runJob(record)
        .catch((error: unknown) => {
          this.options.logger.error('Unhandled job execution error', {
            jobId: record.id,
            error,
          });
        })
        .finally(() => {
          lane.activeCount = Math.max(0, lane.activeCount - 1);
          this.drainLane(laneName);
        });
    }
  }

  private async runJob(record: InternalJobRecord): Promise<void> {
    const jobLogger = this.options.logger.child(
      {
        jobId: record.id,
        jobType: record.type,
      },
      record.artifacts.logPath
    );

    record.status = 'running';
    record.startedAt = new Date().toISOString();
    this.persist(record);

    jobLogger.info('Job started', {
      lane: record.lane,
      input: record.input,
    });

    try {
      const result = await record.run({
        jobId: record.id,
        jobDirectory: record.artifacts.jobDirectory,
        logger: jobLogger,
      });

      record.status = 'completed';
      record.finishedAt = new Date().toISOString();
      record.result = result;
      record.error = undefined;
      jobLogger.info('Job completed successfully');
    } catch (error: unknown) {
      const appError = toAppError(error);
      record.status = 'failed';
      record.finishedAt = new Date().toISOString();
      record.error = this.toErrorSummary(appError);
      jobLogger.error('Job failed', {
        error,
      });
    } finally {
      this.persist(record);
    }
  }

  private toErrorSummary(error: AppError): JobErrorSummary {
    return {
      code: error.code,
      message: error.message,
      details: error.expose ? error.details : undefined,
    };
  }

  private persist(record: InternalJobRecord): void {
    record.artifacts.files = listFilesRecursively(record.artifacts.jobDirectory).filter(
      (filePath) => this.isTrackedArtifactFile(record, filePath)
    );

    fs.writeFileSync(
      record.artifacts.snapshotPath,
      `${JSON.stringify(this.toPublicRecord(record), null, 2)}\n`,
      'utf8'
    );
  }

  private toPublicRecord<TResult>(record: InternalJobRecord<TResult>): JobSummary<TResult> {
    const output: JobSummary<TResult> = {
      id: record.id,
      type: record.type,
      lane: record.lane,
      status: record.status as JobStatus,
      createdAt: record.createdAt,
      input: record.input,
      artifacts: this.cloneArtifacts(record.artifacts),
    };

    if (record.startedAt) {
      output.startedAt = record.startedAt;
    }

    if (record.finishedAt) {
      output.finishedAt = record.finishedAt;
    }

    if (record.result !== undefined) {
      output.result = record.result;
    }

    if (record.error) {
      output.error = record.error;
    }

    return output;
  }

  private cloneArtifacts(artifacts: JobArtifacts): JobArtifacts {
    return {
      jobDirectory: artifacts.jobDirectory,
      snapshotPath: artifacts.snapshotPath,
      logPath: artifacts.logPath,
      files: [...artifacts.files],
    };
  }

  private isTrackedArtifactFile(record: InternalJobRecord, filePath: string): boolean {
    if (filePath === record.artifacts.snapshotPath) {
      return false;
    }

    return !filePath.includes(`${path.sep}.playwright-profile${path.sep}`);
  }
}
