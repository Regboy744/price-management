import type { Logger } from '../../config/logger.js';

export type JobType = 'scrape';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface JobArtifacts {
  jobDirectory: string;
  snapshotPath: string;
  logPath: string;
  files: string[];
}

export interface JobErrorSummary {
  code: string;
  message: string;
  details?: unknown;
}

export interface JobSummary<TResult = unknown> {
  id: string;
  type: JobType;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  input: unknown;
  result?: TResult;
  error?: JobErrorSummary;
  artifacts: JobArtifacts;
}

export interface JobRunnerContext {
  jobId: string;
  jobDirectory: string;
  logger: Logger;
}

export interface CreateJobRequest<TInput, TResult> {
  type: JobType;
  inputPreview: TInput;
  run: (context: JobRunnerContext) => Promise<TResult>;
}
