import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DEFAULT_REPORT_URL } from '../../config/report.js';
import { pagination } from '../../config/ssrs.js';
import { runAutomatedLogin } from '../auth.js';
import { launchBrowser, attachNetworkCapture } from '../browser.js';
import { waitForReportSurface } from '../report.js';
import type { CaptureOptions, CaptureStats } from '../types.js';
import { envBool } from '../utils.js';
import { createProductsCsvAppender } from './output.js';
import { runParallelSweep } from './parallel.js';
import { runCascadedSweep } from './sweep.js';
import type { ScrapeAllOptions, SweepLimits } from './types.js';

interface MemoryTelemetryControl {
  stop: () => Promise<void>;
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function readTelemetryIntervalMs(): number {
  const raw = process.env['MEM_TELEMETRY_INTERVAL_MS'];
  if (!raw) {
    return 30_000;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 5_000) {
    return 30_000;
  }

  return Math.floor(parsed);
}

function startMemoryTelemetry(input: {
  label: string;
  browser: { pages: () => unknown[] };
  logPath: string;
  getCaptureStats?: () => CaptureStats;
}): MemoryTelemetryControl {
  const intervalMs = readTelemetryIntervalMs();
  let stopped = false;

  fs.mkdirSync(path.dirname(input.logPath), { recursive: true });

  const writeLine = (line: string): void => {
    console.log(line);
    fs.appendFileSync(input.logPath, `${line}\n`, 'utf8');
  };

  const logSnapshot = async (stage: 'tick' | 'stop'): Promise<void> => {
    if (stopped && stage !== 'stop') {
      return;
    }

    const memory = process.memoryUsage();
    const pageCount = (() => {
      try {
        return input.browser.pages().length;
      } catch {
        return 0;
      }
    })();
    const captureStats = input.getCaptureStats ? input.getCaptureStats() : null;

    const base =
      `[memory:${input.label}] stage=${stage} rss=${formatMb(memory.rss)}MB ` +
      `heap=${formatMb(memory.heapUsed)}MB ext=${formatMb(memory.external)}MB pages=${pageCount}`;

    if (!captureStats) {
      writeLine(base);
      return;
    }

    const maxBytesText =
      captureStats.maxBytes === Number.MAX_SAFE_INTEGER
        ? 'unbounded'
        : `${formatMb(captureStats.maxBytes)}MB`;

    writeLine(
      `${base} captures=${captureStats.retainedCount}/${captureStats.maxItems} ` +
      `captureBytes=${formatMb(captureStats.retainedBytes)}MB capLimit=${maxBytesText} ` +
      `captureDropped=${captureStats.droppedCount}`
    );
  };

  void logSnapshot('tick').catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Memory telemetry warning (${input.label}): ${message}`);
  });

  const timer = setInterval(() => {
    void logSnapshot('tick').catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Memory telemetry warning (${input.label}): ${message}`);
    });
  }, intervalMs);

  return {
    stop: async (): Promise<void> => {
      if (stopped) {
        return;
      }

      stopped = true;
      clearInterval(timer);
      await logSnapshot('stop').catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Memory telemetry warning (${input.label}): ${message}`);
      });
    },
  };
}

function toPositiveInteger(value: string, argName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${argName} must be a positive integer.`);
  }
  return Math.floor(parsed);
}

function toNonNegativeInteger(value: string, argName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${argName} must be zero or a positive integer.`);
  }
  return Math.floor(parsed);
}

function parseLimit(value: string, argName: string): number {
  return toPositiveInteger(value, argName);
}

function parseArgs(argv: string[]): ScrapeAllOptions {
  const envUsername = process.env['MS_USERNAME'] || process.env['AAD_USERNAME'] || '';
  const envPassword = process.env['MS_PASSWORD'] || process.env['AAD_PASSWORD'] || '';
  const envAutoLogin =
    process.env['AUTO_LOGIN'] !== undefined
      ? envBool(process.env['AUTO_LOGIN'], false)
      : Boolean(envUsername && envPassword);

  const options: ScrapeAllOptions = {
    reportUrl: DEFAULT_REPORT_URL,
    outputCsvFile: path.join('outputs', 'products.csv'),
    chromePath: process.env['CHROME_PATH'] || '/usr/bin/google-chrome',
    userDataDir: '.playwright-profile',
    headless: false,
    timeoutMs: 300_000,
    autoLogin: envAutoLogin,
    username: envUsername,
    password: envPassword,
    keepSignedIn: envBool(process.env['MS_KEEP_SIGNED_IN'], false),
    selectDelayMs: Number(process.env['SELECT_DELAY_MS'] || 1_000),
    browserActionTimeoutMs: Number(process.env['BROWSER_ACTION_TIMEOUT_MS'] || 15_000),
    selectPostbackTimeoutMs: Number(process.env['SELECT_POSTBACK_TIMEOUT_MS'] || 6_000),
    freshProfile: true,
    renderTimeoutMs: Number(process.env['REPORT_RENDER_TIMEOUT_MS'] || 180_000),
    postRenderCaptureWaitMs: Number(process.env['POST_RENDER_CAPTURE_WAIT_MS'] || 3_000),
    preferredCaptureTimeoutMs: Number(process.env['PREFERRED_CAPTURE_TIMEOUT_MS'] || 5_000),
    forcedAsyncRetries: Number(process.env['FORCED_ASYNC_RETRIES'] || 2),
    requestDelayMs: Number(process.env['REQUEST_DELAY_MS'] || pagination.delayBetweenRequests),
    maxStores: null,
    maxDepartments: null,
    maxSubdepartments: null,
    maxCommodities: null,
    maxFamilies: null,
    parallel: true,
    maxParallelTabs: Number(process.env['PARALLEL_TABS'] || 0) || null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--':
        break;
      case '--url':
        if (!next) throw new Error('Missing value for --url');
        options.reportUrl = next;
        i += 1;
        break;
      case '--output':
      case '--output-csv':
        if (!next) throw new Error(`Missing value for ${arg}`);
        options.outputCsvFile = next;
        i += 1;
        break;
      case '--chrome-path':
        if (!next) throw new Error('Missing value for --chrome-path');
        options.chromePath = next;
        i += 1;
        break;
      case '--user-data-dir':
        if (!next) throw new Error('Missing value for --user-data-dir');
        options.userDataDir = next;
        i += 1;
        break;
      case '--fresh-profile':
        options.freshProfile = true;
        break;
      case '--reuse-profile':
        console.warn('--reuse-profile is ignored. scrape:all always uses a fresh profile.');
        break;
      case '--headless':
        options.headless = true;
        break;
      case '--auto-login':
        options.autoLogin = true;
        break;
      case '--manual-login':
        options.autoLogin = false;
        break;
      case '--username':
        if (!next) throw new Error('Missing value for --username');
        options.username = next;
        i += 1;
        break;
      case '--password':
        if (!next) throw new Error('Missing value for --password');
        options.password = next;
        i += 1;
        break;
      case '--keep-signed-in':
        console.warn('--keep-signed-in is ignored. scrape:all forces no keep-signed-in.');
        break;
      case '--no-keep-signed-in':
        options.keepSignedIn = false;
        break;
      case '--timeout-ms':
        if (!next) throw new Error('Missing value for --timeout-ms');
        options.timeoutMs = toPositiveInteger(next, '--timeout-ms');
        i += 1;
        break;
      case '--render-timeout-ms':
        if (!next) throw new Error('Missing value for --render-timeout-ms');
        options.renderTimeoutMs = toPositiveInteger(next, '--render-timeout-ms');
        i += 1;
        break;
      case '--select-delay-ms':
        if (!next) throw new Error('Missing value for --select-delay-ms');
        options.selectDelayMs = toNonNegativeInteger(next, '--select-delay-ms');
        i += 1;
        break;
      case '--browser-action-timeout-ms':
        if (!next) throw new Error('Missing value for --browser-action-timeout-ms');
        options.browserActionTimeoutMs = toPositiveInteger(next, '--browser-action-timeout-ms');
        i += 1;
        break;
      case '--select-postback-timeout-ms':
        if (!next) throw new Error('Missing value for --select-postback-timeout-ms');
        options.selectPostbackTimeoutMs = toPositiveInteger(next, '--select-postback-timeout-ms');
        i += 1;
        break;
      case '--post-render-capture-wait-ms':
        if (!next) throw new Error('Missing value for --post-render-capture-wait-ms');
        options.postRenderCaptureWaitMs = toNonNegativeInteger(next, '--post-render-capture-wait-ms');
        i += 1;
        break;
      case '--preferred-capture-timeout-ms':
        if (!next) throw new Error('Missing value for --preferred-capture-timeout-ms');
        options.preferredCaptureTimeoutMs = toNonNegativeInteger(next, '--preferred-capture-timeout-ms');
        i += 1;
        break;
      case '--forced-async-retries':
        if (!next) throw new Error('Missing value for --forced-async-retries');
        options.forcedAsyncRetries = toNonNegativeInteger(next, '--forced-async-retries');
        i += 1;
        break;
      case '--request-delay-ms':
        if (!next) throw new Error('Missing value for --request-delay-ms');
        options.requestDelayMs = toNonNegativeInteger(next, '--request-delay-ms');
        i += 1;
        break;
      case '--max-stores':
        if (!next) throw new Error('Missing value for --max-stores');
        options.maxStores = parseLimit(next, '--max-stores');
        i += 1;
        break;
      case '--max-departments':
        if (!next) throw new Error('Missing value for --max-departments');
        options.maxDepartments = parseLimit(next, '--max-departments');
        i += 1;
        break;
      case '--max-subdepartments':
        if (!next) throw new Error('Missing value for --max-subdepartments');
        options.maxSubdepartments = parseLimit(next, '--max-subdepartments');
        i += 1;
        break;
      case '--max-commodities':
        if (!next) throw new Error('Missing value for --max-commodities');
        options.maxCommodities = parseLimit(next, '--max-commodities');
        i += 1;
        break;
      case '--max-families':
        if (!next) throw new Error('Missing value for --max-families');
        options.maxFamilies = parseLimit(next, '--max-families');
        i += 1;
        break;
      case '--parallel':
        options.parallel = true;
        break;
      case '--sequential':
        options.parallel = false;
        break;
      case '--max-parallel-tabs':
        if (!next) throw new Error('Missing value for --max-parallel-tabs');
        options.maxParallelTabs = toPositiveInteger(next, '--max-parallel-tabs');
        i += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.freshProfile = true;
  options.keepSignedIn = false;
  return options;
}

function printUsage(): void {
  console.log('Usage: pnpm scrape:all [options]');
  console.log('');
  console.log('Options:');
  console.log('  --url <report-url>                      Report page URL to open');
  console.log('  --output <path>                         CSV output path (default: outputs/products.csv)');
  console.log('  --chrome-path <path>                    Chrome executable path');
  console.log('  --user-data-dir <path>                  Browser profile directory');
  console.log('  --fresh-profile                         Delete browser profile before run (always on)');
  console.log('  --headless                              Run browser in headless mode');
  console.log('  --auto-login                            Use credentials from .env');
  console.log('  --manual-login                          Disable auto login');
  console.log('  --username <value>                      Login username/email');
  console.log('  --password <value>                      Login password');
  console.log('  --keep-signed-in                        Ignored (fresh mode forces No)');
  console.log('  --no-keep-signed-in                     Keep signed in = No (default)');
  console.log('  --timeout-ms <ms>                       Wait timeout for report surface');
  console.log('  --render-timeout-ms <ms>                Wait timeout after View Report click');
  console.log('  --select-delay-ms <ms>                  Delay after dropdown selection');
  console.log('  --browser-action-timeout-ms <ms>        Hard timeout for page actions');
  console.log('  --select-postback-timeout-ms <ms>       Wait for dropdown postback');
  console.log('  --post-render-capture-wait-ms <ms>      Extra wait for final network payload');
  console.log('  --preferred-capture-timeout-ms <ms>     Wait for preferred payload after render');
  console.log('  --forced-async-retries <n>              Retry count for forced async postback');
  console.log('  --request-delay-ms <ms>                 Delay between replay requests');
  console.log('  --max-stores <n>                        Limit stores for test runs');
  console.log('  --max-departments <n>                   Limit departments for test runs');
  console.log('  --max-subdepartments <n>                Limit subdepartments for test runs');
  console.log('  --max-commodities <n>                   Limit commodities for test runs');
  console.log('  --max-families <n>                      Limit families for test runs');
  console.log('  --parallel                              Run stores in parallel tabs (default)');
  console.log('  --sequential                            Run stores sequentially in one tab');
  console.log('  --max-parallel-tabs <n>                 Max concurrent tabs (default: all stores)');
  console.log('  --help                                  Show this help');
  console.log('');
  console.log('Env vars: MS_USERNAME, MS_PASSWORD, AUTO_LOGIN, CHROME_PATH, REQUEST_DELAY_MS,');
  console.log('  SELECT_DELAY_MS, BROWSER_ACTION_TIMEOUT_MS, SELECT_POSTBACK_TIMEOUT_MS, REPORT_RENDER_TIMEOUT_MS,');
  console.log('  POST_RENDER_CAPTURE_WAIT_MS, PREFERRED_CAPTURE_TIMEOUT_MS, FORCED_ASYNC_RETRIES,');
  console.log('  MS_KEEP_SIGNED_IN, PARALLEL_TABS, CAPTURE_MAX_ITEMS, CAPTURE_MAX_BYTES_MB,');
  console.log('  STORE_RETRY_COUNT, MAX_FRESH_TAB_RESUMES_PER_STORE, PARALLEL_TAB_STAGGER_MS, HTTP_REQUEST_TIMEOUT_MS,');
  console.log('  HTTP_REQUEST_RETRIES, HTTP_REQUEST_RETRY_DELAY_MS, MEM_TELEMETRY_INTERVAL_MS');
}

function waitForEnter(promptText: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${promptText}\n`, () => {
      rl.close();
      resolve();
    });
  });
}

function toCaptureOptions(options: ScrapeAllOptions): CaptureOptions {
  return {
    reportUrl: options.reportUrl,
    sessionFile: 'outputs/session.ts',
    chromePath: options.chromePath,
    userDataDir: options.userDataDir,
    headless: options.headless,
    timeoutMs: options.timeoutMs,
    autoLogin: options.autoLogin,
    username: options.username,
    password: options.password,
    keepSignedIn: options.keepSignedIn,
    applySelects: false,
    selectDelayMs: options.selectDelayMs,
    browserActionTimeoutMs: options.browserActionTimeoutMs,
    selectPostbackTimeoutMs: options.selectPostbackTimeoutMs,
    freshProfile: options.freshProfile,
    renderTimeoutMs: options.renderTimeoutMs,
    postRenderCaptureWaitMs: options.postRenderCaptureWaitMs,
    preferredCaptureTimeoutMs: options.preferredCaptureTimeoutMs,
    forcedAsyncRetries: options.forcedAsyncRetries,
  };
}

async function runSequentialMode(options: ScrapeAllOptions): Promise<void> {
  const captureOptions = toCaptureOptions(options);
  const limits: SweepLimits = {
    maxStores: options.maxStores,
    maxDepartments: options.maxDepartments,
    maxSubdepartments: options.maxSubdepartments,
    maxCommodities: options.maxCommodities,
    maxFamilies: options.maxFamilies,
  };

  const outputCsvPath = path.resolve(options.outputCsvFile);
  const errorLogPath = path.resolve('outputs', 'scrape-all-errors.log');
  const memoryLogPath = path.resolve('outputs', 'memory-metrics.log');

  fs.rmSync(errorLogPath, { force: true });
  fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });

  console.log('Auto login:', captureOptions.autoLogin ? 'enabled' : 'disabled');
  console.log('Fresh profile: forced on (always starts clean)');
  console.log('Keep signed in: forced off for fresh sessions');
  console.log('Report URL:', captureOptions.reportUrl);
  console.log('Output CSV:', outputCsvPath);
  console.log('Mode: single-tab sweep (sequential)');
  console.log('Replay request delay (ms):', options.requestDelayMs);
  console.log(
    'Limits:',
    `stores=${limits.maxStores ?? 'all'},`,
    `departments=${limits.maxDepartments ?? 'all'},`,
    `subdepartments=${limits.maxSubdepartments ?? 'all'},`,
    `commodities=${limits.maxCommodities ?? 'all'},`,
    `families=${limits.maxFamilies ?? 'all'}`
  );

  const browser = await launchBrowser(captureOptions);
  const csvAppender = createProductsCsvAppender(outputCsvPath);
  let captureContext: ReturnType<typeof attachNetworkCapture> | null = null;
  let memoryTelemetry: MemoryTelemetryControl | null = null;

  try {
    const page = await browser.newPage();
    await page.bringToFront().catch(() => null);

    page.on('pageerror', (error: Error) => {
      const message = error?.message || String(error);
      const logLine = `[sequential] pageerror: ${message}`;
      console.error(logLine);
      fs.appendFileSync(errorLogPath, `[${new Date().toISOString()}] ${logLine}\n`, 'utf8');
    });

    page.on('crash', () => {
      const logLine = '[sequential] page crashed.';
      console.error(logLine);
      fs.appendFileSync(errorLogPath, `[${new Date().toISOString()}] ${logLine}\n`, 'utf8');
    });

    captureContext = attachNetworkCapture(page);
    const {
      captures,
      getCaptureCount,
      clearCaptures,
      detachCapture,
      getCaptureStats,
    } = captureContext;

    memoryTelemetry = startMemoryTelemetry({
      label: 'sequential',
      browser,
      logPath: memoryLogPath,
      getCaptureStats,
    });

    console.log('Opening report URL...');
    await page.goto(captureOptions.reportUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });

    if (captureOptions.autoLogin) {
      await runAutomatedLogin(page, captureOptions);
    } else if (!captureOptions.headless) {
      console.log('Complete login/MFA in the browser, then open the report until it loads.');
      await waitForEnter('Press Enter after the report page is visible.');
    } else {
      throw new Error('Headless mode requires --auto-login or a pre-authenticated profile.');
    }

    const reportSurface = await waitForReportSurface(page, captureOptions.timeoutMs);
    if (!reportSurface) {
      throw new Error('Could not detect report surface after login.');
    }

    console.log('Report page detected at:', reportSurface.currentUrl);

    const stats = await runCascadedSweep({
      page,
      captures,
      getCaptureCount,
      clearCaptures,
      getCaptureStats,
      captureOptions,
      requestDelayMs: Math.max(0, options.requestDelayMs),
      limits,
      csvAppender,
      errorLogPath,
    });

    detachCapture();
    clearCaptures();

    console.log('Sweep finished.');
    console.log('Stores processed:', stats.storesProcessed);
    console.log('Combinations visited:', stats.combinationsVisited);
    console.log('Combinations scraped:', stats.combinationsScraped);
    console.log('Combinations failed:', stats.combinationsFailed);
    console.log('Page requests:', stats.pageRequests);
    console.log('Rows written:', stats.rowsWritten);
    console.log('CSV:', outputCsvPath);

    if (stats.combinationsFailed > 0) {
      console.log('Errors log:', errorLogPath);
    }
  } finally {
    if (memoryTelemetry) {
      await memoryTelemetry.stop();
    }
    if (captureContext) {
      captureContext.detachCapture();
      captureContext.clearCaptures();
    }
    await csvAppender.close();
    await browser.close();
  }
}

async function runParallelMode(options: ScrapeAllOptions): Promise<void> {
  const captureOptions = toCaptureOptions(options);
  const limits: SweepLimits = {
    maxStores: options.maxStores,
    maxDepartments: options.maxDepartments,
    maxSubdepartments: options.maxSubdepartments,
    maxCommodities: options.maxCommodities,
    maxFamilies: options.maxFamilies,
  };

  const outputDir = path.resolve(path.dirname(options.outputCsvFile));
  const errorLogPath = path.resolve('outputs', 'scrape-all-errors.log');
  const memoryLogPath = path.resolve('outputs', 'memory-metrics.log');

  fs.rmSync(errorLogPath, { force: true });
  fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });

  console.log('Auto login:', captureOptions.autoLogin ? 'enabled' : 'disabled');
  console.log('Fresh profile: forced on (always starts clean)');
  console.log('Keep signed in: forced off for fresh sessions');
  console.log('Report URL:', captureOptions.reportUrl);
  console.log('Output dir:', outputDir);
  console.log('Mode: parallel tabs (one tab per store)');
  console.log('Max parallel tabs:', options.maxParallelTabs ?? 'all stores');
  console.log('Replay request delay (ms):', options.requestDelayMs);
  console.log(
    'Limits:',
    `stores=${limits.maxStores ?? 'all'},`,
    `departments=${limits.maxDepartments ?? 'all'},`,
    `subdepartments=${limits.maxSubdepartments ?? 'all'},`,
    `commodities=${limits.maxCommodities ?? 'all'},`,
    `families=${limits.maxFamilies ?? 'all'}`
  );

  const browser = await launchBrowser(captureOptions);
  let memoryTelemetry: MemoryTelemetryControl | null = null;

  try {
    memoryTelemetry = startMemoryTelemetry({
      label: 'parallel',
      browser,
      logPath: memoryLogPath,
    });

    const initialPage = await browser.newPage();
    await initialPage.bringToFront().catch(() => null);

    initialPage.on('pageerror', (error: Error) => {
      const message = error?.message || String(error);
      const logLine = `[parallel-login] pageerror: ${message}`;
      console.error(logLine);
      fs.appendFileSync(errorLogPath, `[${new Date().toISOString()}] ${logLine}\n`, 'utf8');
    });

    initialPage.on('crash', () => {
      const logLine = '[parallel-login] page crashed.';
      console.error(logLine);
      fs.appendFileSync(errorLogPath, `[${new Date().toISOString()}] ${logLine}\n`, 'utf8');
    });

    console.log('Opening report URL for login...');
    await initialPage.goto(captureOptions.reportUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });

    if (captureOptions.autoLogin) {
      await runAutomatedLogin(initialPage, captureOptions);
    } else if (!captureOptions.headless) {
      console.log('Complete login/MFA in the browser, then open the report until it loads.');
      await waitForEnter('Press Enter after the report page is visible.');
    } else {
      throw new Error('Headless mode requires --auto-login or a pre-authenticated profile.');
    }

    const reportSurface = await waitForReportSurface(initialPage, captureOptions.timeoutMs);
    if (!reportSurface) {
      throw new Error('Could not detect report surface after login.');
    }

    console.log('Report page detected at:', reportSurface.currentUrl);

    const result = await runParallelSweep({
      browser,
      initialPage,
      captureOptions,
      requestDelayMs: Math.max(0, options.requestDelayMs),
      limits,
      maxParallelTabs: options.maxParallelTabs,
      outputDir,
      errorLogPath,
    });

    const stats = result.aggregatedStats;
    const succeeded = result.storeResults.filter((r) => !r.error);
    const failed = result.storeResults.filter((r) => r.error);

    console.log('');
    console.log('Parallel sweep finished.');
    console.log('Stores processed:', stats.storesProcessed);
    console.log('Stores succeeded:', succeeded.length);
    console.log('Stores failed:', failed.length);
    console.log('Combinations visited:', stats.combinationsVisited);
    console.log('Combinations scraped:', stats.combinationsScraped);
    console.log('Combinations failed:', stats.combinationsFailed);
    console.log('Page requests:', stats.pageRequests);
    console.log('Total rows written:', stats.rowsWritten);
    console.log('');

    console.log('CSV files:');
    for (const r of succeeded) {
      console.log(`  ${r.storeName}: ${r.csvPath} (${r.stats.rowsWritten} rows)`);
    }

    if (failed.length > 0) {
      console.log('');
      console.log('Failed stores:');
      for (const r of failed) {
        console.log(`  ${r.storeName}: ${r.error}`);
      }
      console.log('Errors log:', errorLogPath);
    }
  } finally {
    if (memoryTelemetry) {
      await memoryTelemetry.stop();
    }
    await browser.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  if (options.parallel) {
    await runParallelMode(options);
  } else {
    await runSequentialMode(options);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Scrape-all failed:', message);
  process.exit(1);
});
