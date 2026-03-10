import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { sweepFields } from '../../config/sweep.js';
import { attachNetworkCapture } from '../browser.js';
import { getSelectOptions, waitForDropdownEnabled } from '../dom.js';
import { waitForReportSurface } from '../report.js';
import type { CaptureOptions } from '../types.js';
import { resolveBrowserActionTimeoutMs, sleep, withTimeout } from '../utils.js';
import { createProductsCsvAppender, sanitizeStoreName } from './output.js';
import { runCascadedSweep, SweepResumeRequiredError } from './sweep.js';
import type {
  ParallelStoreResult,
  SweepLimits,
  SweepOption,
  SweepResumeCursor,
  SweepStats,
} from './types.js';

interface ParallelSweepInput {
  browser: BrowserContext;
  initialPage: Page;
  captureOptions: CaptureOptions;
  requestDelayMs: number;
  limits: SweepLimits;
  storeCandidates?: SweepOption[];
  maxParallelTabs: number | null;
  outputDir: string;
  errorLogPath: string;
}

interface ParallelSweepResult {
  aggregatedStats: SweepStats;
  storeResults: ParallelStoreResult[];
}

function envNonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function readStoreRetryCount(): number {
  return Math.max(0, envNonNegativeInteger('STORE_RETRY_COUNT', 1));
}

function readParallelTabStaggerMs(): number {
  return Math.max(0, envNonNegativeInteger('PARALLEL_TAB_STAGGER_MS', 300));
}

const PAGE_CLOSE_TIMEOUT_MS = 5_000;

function readStoreWallClockTimeoutMs(): number {
  return Math.max(0, envNonNegativeInteger('STORE_WALL_CLOCK_TIMEOUT_MS', 0));
}

function createEmptyStats(): SweepStats {
  return {
    storesProcessed: 0,
    combinationsVisited: 0,
    combinationsScraped: 0,
    combinationsFailed: 0,
    rowsWritten: 0,
    pageRequests: 0,
  };
}

function readMaxFreshTabResumes(): number {
  return Math.max(1, envNonNegativeInteger('MAX_FRESH_TAB_RESUMES_PER_STORE', 25));
}

function appendError(errorLogPath: string, message: string): void {
  fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });
  fs.appendFileSync(errorLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

function isRetriableStoreError(message: string): boolean {
  const normalized = String(message || '').toLowerCase();

  return [
    'timeout',
    'target page, context or browser has been closed',
    'execution context was destroyed',
    'frame was detached',
    'navigation failed',
    'net::',
    'protocol error',
    'connection closed',
    'econnreset',
    'etimedout',
    'socket hang up',
    'dropdown stayed disabled',
    'error state after view report',
    'report viewer returned error',
    'could not detect report surface',
  ].some((token) => normalized.includes(token));
}

function attachPageDiagnostics(
  page: Page,
  storeLabel: string,
  errorLogPath: string
): () => void {
  const onPageError = (error: Error): void => {
    const message = error?.message || String(error);
    const logLine = `${storeLabel}: pageerror: ${message}`;
    console.error(logLine);
    appendError(errorLogPath, logLine);
  };

  const onCrash = (): void => {
    const logLine = `${storeLabel}: page crashed.`;
    console.error(logLine);
    appendError(errorLogPath, logLine);
  };

  page.on('pageerror', onPageError);
  page.on('crash', onCrash);

  return (): void => {
    page.off('pageerror', onPageError);
    page.off('crash', onCrash);
  };
}

function toSweepOptions(
  options: Array<{ value: string; text: string }>
): SweepOption[] {
  return options
    .filter((option) => option.value.trim().length > 0)
    .map((option) => ({
      value: option.value,
      text: option.text,
    }));
}

async function discoverStores(
  page: Page,
  maxStores: number | null
): Promise<SweepOption[]> {
  const enabled = await waitForDropdownEnabled(
    page,
    sweepFields.store.selector,
    45_000
  );
  if (!enabled) {
    throw new Error('Store dropdown stayed disabled while discovering stores.');
  }

  const rawOptions = await getSelectOptions(page, sweepFields.store.selector);
  const stores = toSweepOptions(rawOptions);

  if (!stores.length) {
    throw new Error('Store dropdown has no selectable options.');
  }

  console.log(`Discovered ${stores.length} stores.`);

  if (maxStores !== null && maxStores > 0) {
    const limited = stores.slice(0, maxStores);
    console.log(`Limited to ${limited.length} stores (--max-stores ${maxStores}).`);
    return limited;
  }

  return stores;
}

function generateStoreCsvPath(outputDir: string, store: SweepOption): string {
  const safeName = sanitizeStoreName(store.text);
  return path.join(outputDir, `store-${safeName}.csv`);
}

function formatResumeCursor(cursor: SweepResumeCursor): string {
  const levels = [
    cursor.store.option.text,
    cursor.department?.option.text,
    cursor.subdepartment?.option.text,
    cursor.commodity?.option.text,
    cursor.family?.option.text,
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));

  const skipped = cursor[cursor.skipLevel]?.option.text || '(unknown)';
  return `${levels.join(' > ')} | next after ${cursor.skipLevel} ${skipped}`;
}

async function processStore(
  browser: BrowserContext,
  store: SweepOption,
  captureOptions: CaptureOptions,
  requestDelayMs: number,
  limits: SweepLimits,
  csvPath: string,
  errorLogPath: string,
  storeIndex: number,
  totalStores: number,
  startupDelayMs: number
): Promise<ParallelStoreResult> {
  const prefix = `[tab-${storeIndex + 1}/${totalStores}]`;
  const storeLabel = `${prefix} ${store.text}`;
  const maxAttempts = 1 + readStoreRetryCount();
  const maxFreshTabResumes = readMaxFreshTabResumes();

  let attempt = 1;
  let resumeCount = 0;
  let resumeAfter: SweepResumeCursor | null = null;
  let stats = createEmptyStats();
  let csvAppender = createProductsCsvAppender(csvPath);

  try {
    while (attempt <= maxAttempts) {
      if (startupDelayMs > 0 && attempt === 1 && resumeCount === 0 && !resumeAfter) {
        await sleep(startupDelayMs);
      }

      const openLabel = resumeAfter
        ? `${storeLabel}: opening new tab (attempt ${attempt}/${maxAttempts}, resume ${resumeCount + 1}/${maxFreshTabResumes})...`
        : `${storeLabel}: opening new tab (attempt ${attempt}/${maxAttempts})...`;
      console.log(openLabel);

      let page: Page | undefined;
      let captureContext: ReturnType<typeof attachNetworkCapture> | null = null;
      let detachDiagnostics: (() => void) | null = null;

      try {
        page = await browser.newPage();
        const actionTimeoutMs = resolveBrowserActionTimeoutMs(captureOptions);
        page.setDefaultTimeout(actionTimeoutMs);
        page.setDefaultNavigationTimeout(Math.max(60_000, captureOptions.timeoutMs));

        if (!captureOptions.headless && storeIndex === 0) {
          await page.bringToFront().catch(() => null);
        }

        detachDiagnostics = attachPageDiagnostics(page, storeLabel, errorLogPath);
        captureContext = attachNetworkCapture(page);
        const {
          captures,
          getCaptureCount,
          clearCaptures,
          getCaptureStats,
        } = captureContext;

        console.log(`${storeLabel}: navigating to report...`);
        await page.goto(captureOptions.reportUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 120_000,
        });

        const reportSurface = await waitForReportSurface(
          page,
          captureOptions.timeoutMs,
          actionTimeoutMs
        );
        if (!reportSurface) {
          throw new Error(`${storeLabel}: could not detect report surface.`);
        }

        console.log(
          `${storeLabel}: report surface ready, starting sweep${
            resumeAfter ? ` (${formatResumeCursor(resumeAfter)})` : ''
          }...`
        );

        const sweepLimits: SweepLimits = {
          maxStores: 1,
          maxDepartments: limits.maxDepartments,
          maxSubdepartments: limits.maxSubdepartments,
          maxCommodities: limits.maxCommodities,
          maxFamilies: limits.maxFamilies,
        };

        await runCascadedSweep({
          page,
          captures,
          getCaptureCount,
          clearCaptures,
          getCaptureStats,
          captureOptions,
          requestDelayMs,
          limits: sweepLimits,
          csvAppender,
          errorLogPath,
          storeCandidates: [store],
          logPrefix: prefix,
          stats,
          resumeAfter,
          throwOnFreeze: true,
        });

        const captureStats = getCaptureStats();

        console.log(
          `${storeLabel}: completed. combinations=${stats.combinationsScraped}, rows=${stats.rowsWritten}, failed=${stats.combinationsFailed}, droppedCaptures=${captureStats.droppedCount}, resumes=${resumeCount}`
        );

        return {
          storeName: store.text,
          storeValue: store.value,
          csvPath,
          stats,
        };
      } catch (error) {
        if (error instanceof SweepResumeRequiredError) {
          resumeAfter = error.resumeAfter;
          resumeCount += 1;

          if (resumeCount > maxFreshTabResumes) {
            const message = `${storeLabel}: exceeded fresh-tab resumes (${maxFreshTabResumes}) — ${error.message}`;
            console.error(message);
            appendError(errorLogPath, message);
            return {
              storeName: store.text,
              storeValue: store.value,
              csvPath,
              stats,
              error: message,
            };
          }

          const resumeMessage = `${storeLabel}: reopening fresh tab to resume after ${formatResumeCursor(resumeAfter)} (${resumeCount}/${maxFreshTabResumes})`;
          console.warn(resumeMessage);
          appendError(errorLogPath, resumeMessage);
          await sleep(1_000);
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
        const retryable = attempt < maxAttempts && isRetriableStoreError(message);

        console.error(`${storeLabel}: FAILED (attempt ${attempt}/${maxAttempts}) — ${message}`);
        appendError(
          errorLogPath,
          `${storeLabel}: attempt ${attempt}/${maxAttempts} failed: ${message}`
        );

        if (retryable) {
          console.warn(`${storeLabel}: retrying with a fresh tab...`);
          await csvAppender.close().catch(() => null);
          fs.rmSync(csvPath, { force: true });
          csvAppender = createProductsCsvAppender(csvPath);
          stats = createEmptyStats();
          resumeAfter = null;
          resumeCount = 0;
          attempt += 1;
          await sleep(1_000);
          continue;
        }

        return {
          storeName: store.text,
          storeValue: store.value,
          csvPath,
          stats,
          error: message,
        };
      } finally {
        if (detachDiagnostics) {
          detachDiagnostics();
        }

        if (captureContext) {
          captureContext.detachCapture();
          captureContext.clearCaptures();
        }

        if (page) {
          console.log(`${storeLabel}: closing tab...`);
          await Promise.race([
            page.close().catch(() => null),
            sleep(PAGE_CLOSE_TIMEOUT_MS),
          ]);
        }
      }
    }

    return {
      storeName: store.text,
      storeValue: store.value,
      csvPath,
      stats,
      error: `${storeLabel}: exhausted retries without result.`,
    };
  } finally {
    await csvAppender.close().catch(() => null);
  }
}

function aggregateStats(results: ParallelStoreResult[]): SweepStats {
  const totals: SweepStats = {
    storesProcessed: 0,
    combinationsVisited: 0,
    combinationsScraped: 0,
    combinationsFailed: 0,
    rowsWritten: 0,
    pageRequests: 0,
  };

  for (const result of results) {
    totals.storesProcessed += result.stats.storesProcessed;
    totals.combinationsVisited += result.stats.combinationsVisited;
    totals.combinationsScraped += result.stats.combinationsScraped;
    totals.combinationsFailed += result.stats.combinationsFailed;
    totals.rowsWritten += result.stats.rowsWritten;
    totals.pageRequests += result.stats.pageRequests;
  }

  return totals;
}

export async function runParallelSweep(
  input: ParallelSweepInput
): Promise<ParallelSweepResult> {
  const stores = input.storeCandidates ?? (await discoverStores(input.initialPage, input.limits.maxStores));

  if (input.storeCandidates) {
    console.log(`Parallel sweep: assigned ${stores.length} requested stores.`);
  }

  await input.initialPage.goto('about:blank').catch(() => null);
  await input.initialPage.close().catch(() => null);

  if (!stores.length) {
    return {
      aggregatedStats: {
        storesProcessed: 0,
        combinationsVisited: 0,
        combinationsScraped: 0,
        combinationsFailed: 0,
        rowsWritten: 0,
        pageRequests: 0,
      },
      storeResults: [],
    };
  }

  fs.mkdirSync(input.outputDir, { recursive: true });

  const maxTabs = input.maxParallelTabs ?? stores.length;
  const effectiveTabs = Math.min(Math.max(1, maxTabs), stores.length);
  const staggerMs = readParallelTabStaggerMs();

  console.log(`Parallel sweep: ${stores.length} stores, ${effectiveTabs} concurrent tabs.`);
  console.log(`Parallel tab stagger: ${staggerMs}ms`);

  const allResults: ParallelStoreResult[] = [];

  for (let batchStart = 0; batchStart < stores.length; batchStart += effectiveTabs) {
    const batch = stores.slice(batchStart, batchStart + effectiveTabs);
    const batchNum = Math.floor(batchStart / effectiveTabs) + 1;
    const totalBatches = Math.ceil(stores.length / effectiveTabs);

    console.log(
      `Batch ${batchNum}/${totalBatches}: processing ${batch.length} stores (${batch.map((s) => s.text).join(', ')})`
    );

    const storeWallClockTimeoutMs = readStoreWallClockTimeoutMs();

    const batchPromises = batch.map((store, indexInBatch) => {
      const globalIndex = batchStart + indexInBatch;
      const csvPath = generateStoreCsvPath(input.outputDir, store);

      const storePromise = processStore(
        input.browser,
        store,
        input.captureOptions,
        input.requestDelayMs,
        input.limits,
        csvPath,
        input.errorLogPath,
        globalIndex,
        stores.length,
        indexInBatch * staggerMs
      );

      if (storeWallClockTimeoutMs <= 0) {
        return storePromise;
      }

      return withTimeout(
        storePromise,
        storeWallClockTimeoutMs,
        () => new Error(`Store ${store.text} exceeded wall-clock timeout of ${storeWallClockTimeoutMs}ms`)
      ).catch((error): ParallelStoreResult => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tab-${globalIndex + 1}/${stores.length}] ${message}`);
        appendError(input.errorLogPath, message);
        return {
          storeName: store.text,
          storeValue: store.value,
          csvPath,
          stats: createEmptyStats(),
          error: message,
        };
      });
    });

    const batchResults = await Promise.allSettled(batchPromises);

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        allResults.push(result.value);
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.error(`Unexpected batch failure: ${reason}`);
      }
    }

    console.log(`Batch ${batchNum}/${totalBatches}: completed.`);
  }

  return {
    aggregatedStats: aggregateStats(allResults),
    storeResults: allResults,
  };
}
