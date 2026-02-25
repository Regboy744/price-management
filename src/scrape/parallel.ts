import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { sweepFields } from '../../config/sweep.js';
import { attachNetworkCapture } from '../browser.js';
import { getSelectOptions, waitForDropdownEnabled } from '../dom.js';
import { waitForReportSurface } from '../report.js';
import type { CaptureOptions } from '../types.js';
import { sleep } from '../utils.js';
import { createProductsCsvAppender, sanitizeStoreName } from './output.js';
import { runCascadedSweep } from './sweep.js';
import type {
  ParallelStoreResult,
  SweepLimits,
  SweepOption,
  SweepStats,
} from './types.js';

interface ParallelSweepInput {
  browser: BrowserContext;
  initialPage: Page;
  captureOptions: CaptureOptions;
  requestDelayMs: number;
  limits: SweepLimits;
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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (startupDelayMs > 0 && attempt === 1) {
      await sleep(startupDelayMs);
    }

    console.log(`${storeLabel}: opening new tab (attempt ${attempt}/${maxAttempts})...`);

    const csvAppender = createProductsCsvAppender(csvPath);
    let page: Page | undefined;
    let captureContext: ReturnType<typeof attachNetworkCapture> | null = null;
    let detachDiagnostics: (() => void) | null = null;

    try {
      page = await browser.newPage();

      if (!captureOptions.headless && storeIndex === 0 && attempt === 1) {
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

      const reportSurface = await waitForReportSurface(page, captureOptions.timeoutMs);
      if (!reportSurface) {
        throw new Error(`${storeLabel}: could not detect report surface.`);
      }

      console.log(`${storeLabel}: report surface ready, starting sweep...`);

      const sweepLimits: SweepLimits = {
        maxStores: 1,
        maxDepartments: limits.maxDepartments,
        maxSubdepartments: limits.maxSubdepartments,
        maxCommodities: limits.maxCommodities,
        maxFamilies: limits.maxFamilies,
      };

      const stats = await runCascadedSweep({
        page: page as Page,
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
      });

      const captureStats = getCaptureStats();

      console.log(
        `${storeLabel}: completed. combinations=${stats.combinationsScraped}, rows=${stats.rowsWritten}, failed=${stats.combinationsFailed}, droppedCaptures=${captureStats.droppedCount}`
      );

      return {
        storeName: store.text,
        storeValue: store.value,
        csvPath,
        stats,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = attempt < maxAttempts && isRetriableStoreError(message);

      console.error(`${storeLabel}: FAILED (attempt ${attempt}/${maxAttempts}) — ${message}`);
      appendError(
        errorLogPath,
        `${storeLabel}: attempt ${attempt}/${maxAttempts} failed: ${message}`
      );

      if (retryable) {
        console.warn(`${storeLabel}: retrying with a fresh tab...`);
        await sleep(1_000);
        continue;
      }

      return {
        storeName: store.text,
        storeValue: store.value,
        csvPath,
        stats: {
          storesProcessed: 0,
          combinationsVisited: 0,
          combinationsScraped: 0,
          combinationsFailed: 0,
          rowsWritten: 0,
          pageRequests: 0,
        },
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

      await csvAppender.close();

      if (page) {
        await page.goto('about:blank').catch(() => null);
        await page.close().catch(() => null);
      }
    }
  }

  return {
    storeName: store.text,
    storeValue: store.value,
    csvPath,
    stats: {
      storesProcessed: 0,
      combinationsVisited: 0,
      combinationsScraped: 0,
      combinationsFailed: 0,
      rowsWritten: 0,
      pageRequests: 0,
    },
    error: `${storeLabel}: exhausted retries without result.`,
  };
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
  const stores = await discoverStores(input.initialPage, input.limits.maxStores);

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

    const batchPromises = batch.map((store, indexInBatch) => {
      const globalIndex = batchStart + indexInBatch;
      const csvPath = generateStoreCsvPath(input.outputDir, store);

      return processStore(
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
