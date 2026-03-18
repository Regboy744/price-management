import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../../config/logger.js';
import { listFilesRecursively, resolveJobDirectory } from '../../config/paths.js';
import { runWithRuntimeLogger } from '../../runtime-log.js';
import {
  getPublicErrorMessage,
  NotFoundError,
  toAppError,
  type AppError,
} from '../../shared/errors/app-error.js';
import { redactSensitiveData } from '../../shared/utils/redact.js';
import type {
  CreateJobRequest,
  JobArtifacts,
  JobErrorSummary,
  JobStatus,
  JobSummary,
  JobRunnerContext,
} from './job.types.js';

interface InternalJobRecord<TResult = unknown> extends JobSummary<TResult> {
  run: (context: JobRunnerContext) => Promise<TResult>;
}

export interface JobManagerOptions {
  jobsRootDir: string;
  concurrency: number;
  logger: Logger;
}

export class JobManager {
  private readonly jobs = new Map<string, InternalJobRecord>();
  private readonly queue: string[] = [];
  private activeCount = 0;
  private readonly concurrency: number;

  constructor(private readonly options: JobManagerOptions) {
    fs.mkdirSync(options.jobsRootDir, { recursive: true });
    this.concurrency = Math.max(1, options.concurrency);
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
    this.enqueue(jobId);

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

  private enqueue(jobId: string): void {
    this.queue.push(jobId);
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      const record = this.jobs.get(jobId);

      if (!record) {
        continue;
      }

      this.activeCount += 1;
      void this.runJob(record)
        .catch((error: unknown) => {
          this.options.logger.error('Unhandled job execution error', {
            jobId: record.id,
            error,
          });
        })
        .finally(() => {
          this.activeCount = Math.max(0, this.activeCount - 1);
          this.drainQueue();
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
      input: record.input,
    });

    try {
      const result = await runWithRuntimeLogger(jobLogger, async () => {
        return record.run({
          jobId: record.id,
          jobDirectory: record.artifacts.jobDirectory,
          logger: jobLogger,
        });
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
      message: getPublicErrorMessage(error),
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
