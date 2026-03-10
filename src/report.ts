import type { Page } from 'playwright-core';
import type {
  CaptureOptions,
  NetworkCapture,
  PreferredCaptureResult,
  ReportPageState,
  ReportSurfaceState,
} from './types.js';
import {
  resolveBrowserActionTimeoutMs,
  sleep,
  TimedActionError,
  withTimeout,
} from './utils.js';
import { REPORT_CONTENT_MARKERS, VISIBILITY_STATE_SELECTOR } from '../config/report.js';
import { getHiddenFieldValue, waitForPostbackOrStateChange } from './dom.js';

export async function waitForReportSurface(
  page: Page,
  timeoutMs: number,
  actionTimeoutMs = 15_000
): Promise<ReportSurfaceState | null> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const state = await withTimeout(
      page.evaluate(() => {
        const currentUrl = window.location.href;
        const host = window.location.hostname;
        const normalizedHost = String(host || '').toLowerCase();
        const isLoginHost =
          normalizedHost.includes('login.microsoftonline.com') ||
          normalizedHost.endsWith('.microsoftonline.com') ||
          normalizedHost === 'login.live.com' ||
          normalizedHost === 'account.live.com' ||
          normalizedHost.endsWith('.live.com');

        return {
          currentUrl,
          isLoginHost,
          hasReportForm: Boolean(document.querySelector('form[action*="ReportViewer.aspx"]')),
          hasReportViewerControl: Boolean(
            document.querySelector('#ReportViewerControl, [id*="ReportViewerControl"]')
          ),
          title: document.title || '',
        };
      }),
      actionTimeoutMs,
      () => new TimedActionError('Read report surface state', actionTimeoutMs)
    ).catch((error) => {
      if (error instanceof TimedActionError) {
        throw error;
      }
      return null;
    });

    if (
      state &&
      !state.isLoginHost &&
      (state.hasReportForm ||
        state.hasReportViewerControl ||
        state.currentUrl.includes('/Reports/report/') ||
        state.currentUrl.includes('/ReportServer/Pages/ReportViewer.aspx'))
    ) {
      return state;
    }

    await sleep(500);
  }

  return null;
}

export async function waitForReportPageState(
  page: Page,
  timeoutMs: number,
  options?: {
    requireEanHeader?: boolean;
    requireReportTitle?: boolean;
  },
  actionTimeoutMs = 15_000
): Promise<ReportPageState> {
  const start = Date.now();
  const { title, header } = REPORT_CONTENT_MARKERS;
  const requireEanHeader = options?.requireEanHeader ?? true;
  const requireReportTitle = options?.requireReportTitle ?? true;

  let lastState: ReportPageState = {
    visibilityState: '',
    pageUrl: '',
    hasReportTitle: false,
    hasEanHeader: false,
  };

  while (Date.now() - start < timeoutMs) {
    const state = await withTimeout(
      page.evaluate(
        ([titleMarker, headerMarker]: [string, string]) => {
          const field = document.querySelector(
            'input[name="ReportViewerControl$ctl09$VisibilityState$ctl00"]'
          ) as HTMLInputElement | null;

          // Use the visible report content area first — the rendered report
          // title and data table headers live inside #ReportViewerControl_ctl09
          // (specifically its VisibleReportContent child), while _ReportArea
          // is a sibling that mostly holds hidden-field state.
          const reportScope =
            document.querySelector('#VisibleReportContentReportViewerControl_ctl09') ||
            document.querySelector('#ReportViewerControl_ctl09') ||
            document.querySelector('#ReportViewerControl_ctl09_ReportArea') ||
            document.querySelector('#ReportViewerControl') ||
            document.body;

          let hasReportTitle = false;
          let hasEanHeader = false;

          if (reportScope) {
            // Collect all text under reportScope and normalize whitespace so
            // that markers split across multiple text nodes or containing
            // newlines/extra spaces are still matched correctly.
            const rawText = reportScope.textContent || '';
            const normalizedText = rawText.replace(/\s+/g, ' ');

            hasReportTitle = normalizedText.includes(titleMarker);
            hasEanHeader = normalizedText.includes(headerMarker);
          }

          return {
            visibilityState: field ? field.value : '',
            pageUrl: window.location.href,
            hasReportTitle,
            hasEanHeader,
          };
        },
        [title, header] as [string, string]
      ),
      actionTimeoutMs,
      () => new TimedActionError('Read report page state', actionTimeoutMs)
    ).catch((error): ReportPageState => {
      if (error instanceof TimedActionError) {
        throw error;
      }

      return {
        visibilityState: '',
        pageUrl: '',
        hasReportTitle: false,
        hasEanHeader: false,
      };
    });

    lastState = state;

    if (state.visibilityState === 'Error') {
      throw new Error('Report viewer returned Error state after View Report.');
    }

    const titleSatisfied = !requireReportTitle || state.hasReportTitle;
    const headerSatisfied = !requireEanHeader || state.hasEanHeader;

    if (state.visibilityState === 'ReportPage' && titleSatisfied && headerSatisfied) {
      return state;
    }

    await sleep(400);
  }

  const expectedMarkers: string[] = [];
  if (requireReportTitle) expectedMarkers.push(title);
  if (requireEanHeader) expectedMarkers.push(header);

  const markerText = expectedMarkers.length > 0 ? expectedMarkers.join(' and ') : 'ReportPage state';
  const diag = [
    `visibilityState=${lastState.visibilityState || '(empty)'}`,
    `hasTitle=${lastState.hasReportTitle}`,
    `hasEan=${lastState.hasEanHeader}`,
    `url=${lastState.pageUrl || '(unknown)'}`,
  ].join(', ');

  throw new Error(
    `Timed out waiting for report render markers after View Report click (expected: ${markerText}). Diagnostics: ${diag}`
  );
}

export async function triggerReservedAsyncLoadTarget(
  page: Page,
  getCaptureCount: () => number,
  timeoutMs: number,
  actionTimeoutMs: number
): Promise<string> {
  const beforeCaptureCount = getCaptureCount();
  const beforeViewState = await getHiddenFieldValue(page, '#__VIEWSTATE', actionTimeoutMs);

  let triggerOk = false;

  try {
    triggerOk = await withTimeout(
      page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (typeof (globalThis as any).__doPostBack === 'function') {
          (globalThis as any).__doPostBack(
            'ReportViewerControl$ctl09$Reserved_AsyncLoadTarget',
            ''
          );
          return true;
        }

        const eventTarget = document.querySelector(
          '#__EVENTTARGET, input[name="__EVENTTARGET"]'
        ) as HTMLInputElement | null;
        const eventArgument = document.querySelector(
          '#__EVENTARGUMENT, input[name="__EVENTARGUMENT"]'
        ) as HTMLInputElement | null;
        const form = document.querySelector(
          '#ReportViewerForm, #aspnetForm, form[action*="ReportViewer.aspx"], form'
        ) as HTMLFormElement | null;

        if (form) {
          const targetField =
            eventTarget ||
            (() => {
              const input = document.createElement('input');
              input.type = 'hidden';
              input.name = '__EVENTTARGET';
              form.appendChild(input);
              return input;
            })();

          targetField.value = 'ReportViewerControl$ctl09$Reserved_AsyncLoadTarget';

          if (eventArgument) {
            eventArgument.value = '';
          }

          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          } else {
            form.submit();
          }

          return true;
        }

        return false;
      }),
      actionTimeoutMs,
      () => new TimedActionError('Reserved async postback dispatch', actionTimeoutMs)
    );
  } catch (error) {
    if (error instanceof TimedActionError) {
      throw error;
    }
    triggerOk = false;
  }

  if (!triggerOk) return 'not-triggered';

  const result = await waitForPostbackOrStateChange(
    page,
    beforeCaptureCount,
    getCaptureCount,
    beforeViewState,
    timeoutMs,
    actionTimeoutMs
  );

  await sleep(150);
  return result;
}

function isUsableBootstrapBody(body: string): boolean {
  if (!body || body.length < 1_000) return false;

  return (
    body.includes('__VIEWSTATE=') ||
    body.includes('NavigationCorrector%24NewViewState=') ||
    body.includes('NavigationCorrector$NewViewState=')
  );
}

function isPreferredScrapeBootstrapBody(body: string): boolean {
  if (!isUsableBootstrapBody(body)) return false;

  try {
    const params = new URLSearchParams(body);
    const eventTarget = params.get('__EVENTTARGET') || '';
    const ajaxScriptManager = params.get('AjaxScriptManager') || '';
    const newViewState = params.get('NavigationCorrector$NewViewState') || '';

    const hasReportAreaTarget =
      eventTarget === 'ReportViewerControl$ctl09$Reserved_AsyncLoadTarget' ||
      ajaxScriptManager.includes('ReportViewerControl$ctl09$Reserved_AsyncLoadTarget');

    return hasReportAreaTarget && Boolean(newViewState);
  } catch {
    return false;
  }
}

export { isUsableBootstrapBody, isPreferredScrapeBootstrapBody };

export function pickLatestUsableCapture(
  captures: NetworkCapture[],
  minSequenceExclusive: number
): NetworkCapture | null {
  return pickLatestUsableNetworkCapture(captures, minSequenceExclusive, false);
}

function pickLatestUsableNetworkCapture(
  captures: NetworkCapture[],
  minSequenceExclusive: number,
  preferredOnly: boolean
): NetworkCapture | null {
  if (!captures.length) return null;

  const usable = captures.filter(
    (c) =>
      c.sequence > minSequenceExclusive &&
      c.requestUrl.includes('/ReportServer/Pages/ReportViewer.aspx') &&
      c.cookieString &&
      isUsableBootstrapBody(c.bootstrapDataRaw) &&
      (!preferredOnly || isPreferredScrapeBootstrapBody(c.bootstrapDataRaw))
  );

  return usable.length > 0 ? usable[usable.length - 1]! : null;
}

async function waitForPreferredNetworkCapture(
  captures: NetworkCapture[],
  minSequenceExclusive: number,
  timeoutMs: number,
  pollIntervalMs = 250
): Promise<NetworkCapture | null> {
  const maxWaitMs = Math.max(0, timeoutMs);
  const start = Date.now();

  while (Date.now() - start <= maxWaitMs) {
    const preferred = pickLatestUsableNetworkCapture(captures, minSequenceExclusive, true);
    if (preferred) return preferred;
    if (maxWaitMs === 0) break;
    await sleep(Math.max(50, pollIntervalMs));
  }

  return null;
}

export async function ensurePreferredCapture(
  page: Page,
  captures: NetworkCapture[],
  minSequenceExclusive: number,
  options: CaptureOptions,
  getCaptureCount: () => number
): Promise<PreferredCaptureResult> {
  const preferredCaptureTimeoutMs = Math.max(0, options.preferredCaptureTimeoutMs);
  const forcedAsyncRetries = Math.max(0, Math.floor(options.forcedAsyncRetries));

  if (preferredCaptureTimeoutMs > 0) {
    console.log(
      `Waiting up to ${preferredCaptureTimeoutMs}ms for preferred ctl09 network payload capture...`
    );
  }

  let preferred = await waitForPreferredNetworkCapture(
    captures,
    minSequenceExclusive,
    preferredCaptureTimeoutMs
  );

  if (preferred) {
    return {
      selectedCapture: preferred,
      selectedBootstrapSource: 'network-preferred-after-view-report',
      forcedAsyncAttemptCount: 0,
      forcedAsyncResults: [],
    };
  }

  const forcedAsyncResults: string[] = [];
  const actionTimeoutMs = resolveBrowserActionTimeoutMs(options);

  for (let attempt = 1; attempt <= forcedAsyncRetries; attempt++) {
    console.log(
      `Preferred ctl09 payload not captured yet. Forcing reserved async postback (${attempt}/${forcedAsyncRetries})...`
    );

    const asyncTriggerTimeoutMs = Math.max(2_000, options.selectPostbackTimeoutMs);
    const result = await triggerReservedAsyncLoadTarget(
      page,
      getCaptureCount,
      asyncTriggerTimeoutMs,
      actionTimeoutMs
    );
    forcedAsyncResults.push(result);
    console.log(`Forced reserved async postback result: ${result}`);

    const asyncCaptureWaitMs = Math.max(500, Math.floor(options.preferredCaptureTimeoutMs));
    preferred = await waitForPreferredNetworkCapture(captures, minSequenceExclusive, asyncCaptureWaitMs);

    if (preferred) {
      return {
        selectedCapture: preferred,
        selectedBootstrapSource: 'network-preferred-after-forced-async',
        forcedAsyncAttemptCount: attempt,
        forcedAsyncResults,
      };
    }
  }

  return {
    selectedCapture: null,
    selectedBootstrapSource: 'none',
    forcedAsyncAttemptCount: forcedAsyncRetries,
    forcedAsyncResults,
  };
}

export function buildCaptureDiagnostics(
  captures: NetworkCapture[],
  minSequenceExclusive: number
) {
  const after = captures.filter((c) => c.sequence > minSequenceExclusive);
  const preferred = after.filter((c) => isPreferredScrapeBootstrapBody(c.bootstrapDataRaw));
  const targets = Array.from(new Set(after.map((c) => c.eventTarget || '(empty)')));

  return {
    capturesAfterViewReportCount: after.length,
    preferredCapturesAfterViewReportCount: preferred.length,
    eventTargetsAfterViewReport: targets,
  };
}
