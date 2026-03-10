import path from 'node:path';
import { DEFAULT_REPORT_URL } from '../../config/report.js';
import { pagination } from '../../config/ssrs.js';
import { envBool } from '../utils.js';

function readInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.floor(parsed);
}

function readPositiveInteger(name: string, fallback: number): number {
  return Math.max(1, readInteger(name, fallback));
}

function readNonNegativeInteger(name: string, fallback: number): number {
  return Math.max(0, readInteger(name, fallback));
}

export interface AppEnvironment {
  nodeEnv: string;
  port: number;
  storage: {
    outputRootDir: string;
    jobsRootDir: string;
    defaultUserDataDir: string;
  };
  browser: {
    chromePath: string;
  };
  auth: {
    username: string;
    password: string;
    autoLogin: boolean;
    keepSignedIn: boolean;
  };
  captureDefaults: {
    reportUrl: string;
    headless: boolean;
    timeoutMs: number;
    applySelects: boolean;
    selectDelayMs: number;
    browserActionTimeoutMs: number;
    selectPostbackTimeoutMs: number;
    freshProfile: boolean;
    renderTimeoutMs: number;
    postRenderCaptureWaitMs: number;
    preferredCaptureTimeoutMs: number;
    forcedAsyncRetries: number;
  };
  replayDefaults: {
    requestDelayMs: number;
    applyFormOverrides: boolean;
  };
  sweepDefaults: {
    reportUrl: string;
    headless: boolean;
    timeoutMs: number;
    selectDelayMs: number;
    browserActionTimeoutMs: number;
    selectPostbackTimeoutMs: number;
    freshProfile: boolean;
    renderTimeoutMs: number;
    postRenderCaptureWaitMs: number;
    preferredCaptureTimeoutMs: number;
    forcedAsyncRetries: number;
    requestDelayMs: number;
    parallel: boolean;
    maxParallelTabs: number | null;
  };
  queue: {
    browserConcurrency: number;
    replayConcurrency: number;
  };
}

export function loadAppEnvironment(): AppEnvironment {
  const username = process.env['MS_USERNAME'] || process.env['AAD_USERNAME'] || '';
  const password = process.env['MS_PASSWORD'] || process.env['AAD_PASSWORD'] || '';
  const autoLogin =
    process.env['AUTO_LOGIN'] !== undefined
      ? envBool(process.env['AUTO_LOGIN'], false)
      : Boolean(username && password);

  const outputRootDir = path.resolve(process.env['OUTPUT_DIR'] || 'outputs');
  const jobsRootDir = path.join(outputRootDir, 'jobs');

  return {
    nodeEnv: process.env['NODE_ENV'] || 'development',
    port: readPositiveInteger('PORT', 3000),
    storage: {
      outputRootDir,
      jobsRootDir,
      defaultUserDataDir: path.resolve(process.env['USER_DATA_DIR'] || '.playwright-profile'),
    },
    browser: {
      chromePath: process.env['CHROME_PATH'] || '/usr/bin/google-chrome',
    },
    auth: {
      username,
      password,
      autoLogin,
      keepSignedIn: envBool(process.env['MS_KEEP_SIGNED_IN'], false),
    },
    captureDefaults: {
      reportUrl: DEFAULT_REPORT_URL,
      headless: envBool(process.env['HEADLESS'], false),
      timeoutMs: readPositiveInteger('REPORT_SURFACE_TIMEOUT_MS', 300_000),
      applySelects: !envBool(process.env['SKIP_SELECTS'], false),
      selectDelayMs: readNonNegativeInteger('SELECT_DELAY_MS', 1_000),
      browserActionTimeoutMs: readPositiveInteger('BROWSER_ACTION_TIMEOUT_MS', 15_000),
      selectPostbackTimeoutMs: readPositiveInteger('SELECT_POSTBACK_TIMEOUT_MS', 6_000),
      freshProfile: envBool(process.env['FRESH_PROFILE'], true),
      renderTimeoutMs: readPositiveInteger('REPORT_RENDER_TIMEOUT_MS', 180_000),
      postRenderCaptureWaitMs: readNonNegativeInteger('POST_RENDER_CAPTURE_WAIT_MS', 3_000),
      preferredCaptureTimeoutMs: readNonNegativeInteger('PREFERRED_CAPTURE_TIMEOUT_MS', 5_000),
      forcedAsyncRetries: readNonNegativeInteger('FORCED_ASYNC_RETRIES', 2),
    },
    replayDefaults: {
      requestDelayMs: readNonNegativeInteger('REQUEST_DELAY_MS', pagination.delayBetweenRequests),
      applyFormOverrides: !envBool(process.env['SCRAPE_SKIP_FORM_OVERRIDES'], false),
    },
    sweepDefaults: {
      reportUrl: DEFAULT_REPORT_URL,
      headless: envBool(process.env['HEADLESS'], false),
      timeoutMs: readPositiveInteger('REPORT_SURFACE_TIMEOUT_MS', 300_000),
      selectDelayMs: readNonNegativeInteger('SELECT_DELAY_MS', 1_000),
      browserActionTimeoutMs: readPositiveInteger('BROWSER_ACTION_TIMEOUT_MS', 15_000),
      selectPostbackTimeoutMs: readPositiveInteger('SELECT_POSTBACK_TIMEOUT_MS', 6_000),
      freshProfile: envBool(process.env['FRESH_PROFILE'], true),
      renderTimeoutMs: readPositiveInteger('REPORT_RENDER_TIMEOUT_MS', 180_000),
      postRenderCaptureWaitMs: readNonNegativeInteger('POST_RENDER_CAPTURE_WAIT_MS', 3_000),
      preferredCaptureTimeoutMs: readNonNegativeInteger('PREFERRED_CAPTURE_TIMEOUT_MS', 5_000),
      forcedAsyncRetries: readNonNegativeInteger('FORCED_ASYNC_RETRIES', 2),
      requestDelayMs: readNonNegativeInteger('REQUEST_DELAY_MS', pagination.delayBetweenRequests),
      parallel: true,
      maxParallelTabs: readNonNegativeInteger('PARALLEL_TABS', 0) || null,
    },
    queue: {
      browserConcurrency: readPositiveInteger('BROWSER_JOB_CONCURRENCY', 1),
      replayConcurrency: readPositiveInteger('REPLAY_JOB_CONCURRENCY', 2),
    },
  };
}

export const appEnvironment = loadAppEnvironment();
