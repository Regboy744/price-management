import { eventTargets } from '../../config/ssrs.js';
import { sleepWithAbort, throwIfAborted } from '../utils.js';
import {
  countProductRowCandidates,
  extractPageInfo,
  extractProducts,
  extractReportHtml,
  extractStates,
  hasProductTableHeader,
  saveReplayDebugArtifacts,
} from './parser.js';
import { buildNavigationBody } from './pagination.js';
import { sendRequest } from './request.js';
import type {
  ProductRow,
  ScrapePageInfo,
  ScrapeReplayHooks,
  ScrapeReplayInput,
  ScrapeReplayResult,
} from './types.js';

function normalizeHeaders(
  sourceHeaders: Record<string, string>,
  cookieString: string,
  requestUrl: string
): Record<string, string> {
  const normalized = { ...sourceHeaders };

  for (const key of Object.keys(normalized)) {
    const lower = key.toLowerCase();
    if (lower === 'content-length') {
      delete normalized[key];
    }
  }

  if (cookieString) {
    normalized['Cookie'] = cookieString;
  }

  const hasReferer = Object.keys(normalized).some((key) => key.toLowerCase() === 'referer');
  if (!hasReferer) {
    normalized['Referer'] = requestUrl;
  }

  return normalized;
}

interface ResponseData {
  status: number;
  data: string;
}

async function requestResponseData(
  requestUrl: string,
  requestHeaders: Record<string, string>,
  body: string,
  abortSignal?: AbortSignal
): Promise<ResponseData> {
  const response = await sendRequest(requestUrl, requestHeaders, body, abortSignal);

  return {
    status: response.status,
    data: String(response.data || ''),
  };
}

export async function scrapeFromBootstrap(
  input: ScrapeReplayInput,
  hooks: ScrapeReplayHooks = {}
): Promise<ScrapeReplayResult> {
  const abortSignal = input.abortSignal;

  throwIfAborted(abortSignal, 'Scrape replay aborted');

  const delayMs = Math.max(0, input.delayMs);
  const maxPages = input.maxPages ?? null;
  const collectRows = hooks.collectRows !== false;
  const label = hooks.logLabel ? `${hooks.logLabel} ` : '';

  const requestHeaders = normalizeHeaders(input.requestHeaders, input.cookieString, input.requestUrl);
  const baseFormParams = new URLSearchParams(input.bootstrapBody);

  let responseData = await requestResponseData(
    input.requestUrl,
    requestHeaders,
    baseFormParams.toString(),
    abortSignal
  );

  if (responseData.status >= 400) {
    throw new Error(`${label}Bootstrap request failed with status ${responseData.status}`.trim());
  }

  let reportHtml: string;
  try {
    reportHtml = extractReportHtml(responseData.data, `${hooks.phasePrefix || 'bootstrap'}-bootstrap`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (hooks.allowEmptyReport && message.includes('returned no report content')) {
      responseData = { status: 0, data: '' };
      return {
        rows: [],
        totalRows: 0,
        pagesScraped: [],
        rowsPerPage: {},
        diagnostics: {
          hasProductTableHeader: false,
          rowCandidateCount: 0,
        },
      };
    }
    throw error;
  }

  let pageInfo = extractPageInfo(reportHtml, responseData.data);
  let states = extractStates(responseData.data);
  let firstPageResponseData = pageInfo.currentPage === 1 ? responseData.data : '';
  let firstPageReportHtml = pageInfo.currentPage === 1 ? reportHtml : '';
  responseData = { status: 0, data: '' };

  while (pageInfo.currentPage > 1) {
    throwIfAborted(abortSignal, 'Scrape replay aborted');
    await sleepWithAbort(delayMs, abortSignal, 'Scrape replay aborted');

    const body = buildNavigationBody(baseFormParams, states, pageInfo.currentPage, eventTargets.previous);
    responseData = await requestResponseData(input.requestUrl, requestHeaders, body, abortSignal);

    if (responseData.status >= 400) {
      throw new Error(`${label}Previous-page request failed with status ${responseData.status}`.trim());
    }

    reportHtml = extractReportHtml(responseData.data, `${hooks.phasePrefix || 'bootstrap'}-previous-page`);
    pageInfo = extractPageInfo(reportHtml, responseData.data);
    states = extractStates(responseData.data);
    if (pageInfo.currentPage === 1) {
      firstPageResponseData = responseData.data;
      firstPageReportHtml = reportHtml;
    }
    responseData = { status: 0, data: '' };
  }

  const pagesVisited = new Set<number>();
  const rowsPerPage: Record<number, number> = {};
  const rows: ProductRow[] | null = collectRows ? [] : null;
  let totalRows = 0;
  let hasRenderedProductTableHeader = false;
  let rowCandidateCount = 0;

  while (true) {
    throwIfAborted(abortSignal, 'Scrape replay aborted');

    const pageHasProductTableHeader = hasProductTableHeader(reportHtml);
    const pageRowCandidateCount = countProductRowCandidates(reportHtml);
    const currentRows = extractProducts(reportHtml, pageInfo.currentPage);
    hasRenderedProductTableHeader = hasRenderedProductTableHeader || pageHasProductTableHeader;
    rowCandidateCount += pageRowCandidateCount;

    if (!firstPageReportHtml && pageInfo.currentPage === 1) {
      firstPageReportHtml = reportHtml;
    }
    const pageMeta: ScrapePageInfo = {
      currentPage: pageInfo.currentPage,
      totalPages: pageInfo.totalPages,
    };

    pagesVisited.add(pageInfo.currentPage);
    rowsPerPage[pageInfo.currentPage] = currentRows.length;
    totalRows += currentRows.length;

    if (rows) {
      rows.push(...currentRows);
    }

    if (hooks.onPageRows) {
      await hooks.onPageRows(currentRows, pageMeta);
      throwIfAborted(abortSignal, 'Scrape replay aborted');
    }

    const reachedPageLimit = maxPages !== null && pagesVisited.size >= maxPages;
    if (reachedPageLimit || pageInfo.currentPage >= pageInfo.totalPages) {
      break;
    }

    reportHtml = '';

    await sleepWithAbort(delayMs, abortSignal, 'Scrape replay aborted');

    const body = buildNavigationBody(baseFormParams, states, pageInfo.currentPage, eventTargets.next);
    responseData = await requestResponseData(input.requestUrl, requestHeaders, body, abortSignal);

    if (responseData.status >= 400) {
      throw new Error(`${label}Next-page request failed with status ${responseData.status}`.trim());
    }

    const nextReportHtml = extractReportHtml(
      responseData.data,
      `${hooks.phasePrefix || 'bootstrap'}-next-page`
    );
    const nextPageInfo = extractPageInfo(nextReportHtml, responseData.data);
    states = extractStates(responseData.data);
    responseData = { status: 0, data: '' };

    if (pagesVisited.has(nextPageInfo.currentPage)) {
      throw new Error(`${label}Detected pagination loop at page ${nextPageInfo.currentPage}`.trim());
    }

    reportHtml = nextReportHtml;
    pageInfo = nextPageInfo;
  }

  reportHtml = '';

  let debugResponsePath: string | undefined;
  let debugReportHtmlPath: string | undefined;

  if (totalRows === 0 && hasRenderedProductTableHeader && firstPageResponseData && firstPageReportHtml) {
    const debugArtifacts = saveReplayDebugArtifacts(
      `${hooks.phasePrefix || 'bootstrap'}-zero-rows-with-product-header`,
      firstPageResponseData,
      firstPageReportHtml
    );
    debugResponsePath = debugArtifacts.responsePath;
    debugReportHtmlPath = debugArtifacts.reportHtmlPath;
  }

  return {
    rows: rows || [],
    totalRows,
    pagesScraped: Array.from(pagesVisited).sort((a, b) => a - b),
    rowsPerPage,
    diagnostics: {
      hasProductTableHeader: hasRenderedProductTableHeader,
      rowCandidateCount,
      debugResponsePath,
      debugReportHtmlPath,
    },
  };
}
