import type { ParallelStoreResult, SweepStats } from '../../scrape/types.js';

export interface SweepJobRequest {
  reportUrl?: string;
  chromePath?: string;
  userDataDir?: string;
  headless?: boolean;
  autoLogin?: boolean;
  username?: string;
  password?: string;
  keepSignedIn?: boolean;
  timeoutMs?: number;
  selectDelayMs?: number;
  browserActionTimeoutMs?: number;
  selectPostbackTimeoutMs?: number;
  freshProfile?: boolean;
  renderTimeoutMs?: number;
  postRenderCaptureWaitMs?: number;
  preferredCaptureTimeoutMs?: number;
  forcedAsyncRetries?: number;
  requestDelayMs?: number;
  stores?: string[];
  maxStores?: number;
  maxDepartments?: number;
  maxSubdepartments?: number;
  maxCommodities?: number;
  maxFamilies?: number;
  parallel?: boolean;
  maxParallelTabs?: number;
  outputFileName?: string;
}

export interface SweepJobResult {
  mode: 'parallel' | 'sequential';
  stats: SweepStats;
  outputCsvPath?: string;
  outputDirectory?: string;
  errorLogPath: string;
  memoryLogPath: string;
  storeResults?: ParallelStoreResult[];
}
