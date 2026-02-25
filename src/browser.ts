import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page, Request } from 'playwright-core';
import { REPORT_VIEWER_PATH } from '../config/report.js';
import type { CaptureOptions, NetworkCapture, BrowserContext as AppBrowserContext } from './types.js';

const DEFAULT_CAPTURE_MAX_ITEMS = 80;
const DEFAULT_CAPTURE_MAX_BYTES_MB = 20;
const HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-language',
  'cache-control',
  'content-type',
  'origin',
  'pragma',
  'referer',
  'user-agent',
  'x-microsoftajax',
  'x-requested-with',
]);

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

function readCaptureLimits(): { maxItems: number; maxBytes: number } {
  const configuredMaxItems = envNonNegativeInteger('CAPTURE_MAX_ITEMS', DEFAULT_CAPTURE_MAX_ITEMS);
  const maxItems = Math.max(1, configuredMaxItems || DEFAULT_CAPTURE_MAX_ITEMS);

  const configuredMaxBytesMb = envNonNegativeInteger(
    'CAPTURE_MAX_BYTES_MB',
    DEFAULT_CAPTURE_MAX_BYTES_MB
  );

  if (configuredMaxBytesMb <= 0) {
    return {
      maxItems,
      maxBytes: Number.MAX_SAFE_INTEGER,
    };
  }

  return {
    maxItems,
    maxBytes: configuredMaxBytesMb * 1024 * 1024,
  };
}

function estimateCaptureBytes(capture: NetworkCapture): number {
  let headerBytes = 0;

  for (const [name, value] of Object.entries(capture.requestHeaders || {})) {
    headerBytes += name.length + String(value || '').length + 4;
  }

  const scalarBytes =
    capture.requestUrl.length +
    capture.method.length +
    capture.cookieString.length +
    capture.bootstrapDataRaw.length +
    capture.initialViewState.length +
    capture.capturedAt.length +
    capture.eventTarget.length +
    capture.currentPage.length;

  // JS strings are UTF-16 in memory, so ~2 bytes/char is a reasonable estimate.
  return (scalarBytes + headerBytes) * 2;
}

function pickReplayHeaders(headers: Record<string, string>): Record<string, string> {
  const selected: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (!HEADER_ALLOWLIST.has(lower)) {
      continue;
    }

    if (value === undefined || value === null || String(value).length === 0) {
      continue;
    }

    selected[name] = String(value);
  }

  return selected;
}

export async function launchBrowser(options: CaptureOptions): Promise<BrowserContext> {
  const baseUserDataDir = path.resolve(options.userDataDir);
  let launchUserDataDir = baseUserDataDir;

  if (!fs.existsSync(options.chromePath)) {
    throw new Error(`Chrome executable not found: ${options.chromePath}`);
  }

  if (options.freshProfile) {
    fs.rmSync(baseUserDataDir, { recursive: true, force: true });
    launchUserDataDir = path.join(baseUserDataDir, `run-${Date.now()}-${process.pid}`);
    fs.mkdirSync(launchUserDataDir, { recursive: true });
    console.log('Cleared browser profile root:', baseUserDataDir);
    console.log('Created fresh browser profile:', launchUserDataDir);
  }

  console.log('Launching Chrome:', options.chromePath, '| headless:', options.headless);
  console.log('Profile path:', launchUserDataDir);

  const context = await chromium.launchPersistentContext(launchUserDataDir, {
    executablePath: options.chromePath,
    headless: options.headless,
    viewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-features=TranslateUI,BlinkGenPropertyTrees',
      '--js-flags=--max-old-space-size=256',
    ],
  });

  console.log('Browser context launched.');

  return context;
}

export function attachNetworkCapture(page: Page): AppBrowserContext {
  const captures: NetworkCapture[] = [];
  const captureLimits = readCaptureLimits();

  let captureCount = 0;
  let retainedBytes = 0;
  let droppedCount = 0;
  let droppedBytes = 0;
  let lastDropWarningAt = 0;
  let detached = false;

  console.log(
    `Capture buffer limits: maxItems=${captureLimits.maxItems}, maxBytes=${
      captureLimits.maxBytes === Number.MAX_SAFE_INTEGER
        ? 'unbounded'
        : `${Math.round(captureLimits.maxBytes / 1024 / 1024)}MB`
    }`
  );

  const dropOldestCapture = (): void => {
    const oldest = captures.shift();
    if (!oldest) {
      return;
    }

    const bytes = estimateCaptureBytes(oldest);
    retainedBytes = Math.max(0, retainedBytes - bytes);
    droppedCount += 1;
    droppedBytes += bytes;
  };

  const enforceLimits = (): void => {
    while (
      captures.length > captureLimits.maxItems ||
      retainedBytes > captureLimits.maxBytes
    ) {
      dropOldestCapture();
      if (captures.length === 0) {
        break;
      }
    }

    if (droppedCount > lastDropWarningAt && droppedCount % 25 === 0) {
      lastDropWarningAt = droppedCount;
      console.warn(
        `Capture buffer trimmed: dropped=${droppedCount}, retained=${captures.length}, retainedMB=${(
          retainedBytes / 1024 / 1024
        ).toFixed(2)}`
      );
    }
  };

  const clearCaptures = (): void => {
    captures.length = 0;
    retainedBytes = 0;
  };

  const onRequest = (request: Request): void => {
    try {
      if (request.method() !== 'POST') return;

      const url = request.url();
      if (!url.includes(REPORT_VIEWER_PATH)) return;

      const body = request.postData() || '';
      if (!body) return;

      // Playwright's request.headers() does NOT include cookie-related headers.
      // Use allHeaders() for the full set including cookies.
      // Since the event handler is sync but allHeaders() is async, we handle
      // the async part inside an immediately-invoked async function.
      void (async () => {
        try {
          const headers = await request.allHeaders();
          const cookieString = headers['cookie'] || '';
          if (!cookieString) return;

          const params = new URLSearchParams(body);
          const initialViewState = params.get('__VIEWSTATE') || '';
          if (!initialViewState && !params.get('NavigationCorrector$NewViewState')) return;

          captureCount += 1;

          const capture: NetworkCapture = {
            sequence: captureCount,
            requestUrl: url,
            method: request.method(),
            requestHeaders: pickReplayHeaders(headers as Record<string, string>),
            cookieString,
            bootstrapDataRaw: body,
            initialViewState,
            capturedAt: new Date().toISOString(),
            eventTarget: params.get('__EVENTTARGET') || '',
            currentPage: params.get('ReportViewerControl$ctl05$ctl00$CurrentPage') || '',
          };

          captures.push(capture);
          retainedBytes += estimateCaptureBytes(capture);
          enforceLimits();

          console.log(
            `[capture ${captureCount}] eventTarget=${capture.eventTarget || 'n/a'} currentPage=${capture.currentPage || 'n/a'} bodyLen=${body.length} retained=${captures.length}`
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn('Capture async header warning:', message);
        }
      })();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('Capture parse warning:', message);
    }
  };

  const detachCapture = (): void => {
    if (detached) {
      return;
    }

    detached = true;
    page.off('request', onRequest);
  };

  page.on('request', onRequest);
  page.once('close', detachCapture);

  return {
    captures,
    getCaptureCount: () => captureCount,
    clearCaptures,
    detachCapture,
    getCaptureStats: () => ({
      retainedCount: captures.length,
      retainedBytes,
      droppedCount,
      droppedBytes,
      maxItems: captureLimits.maxItems,
      maxBytes: captureLimits.maxBytes,
    }),
  };
}
