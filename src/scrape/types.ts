import type { SweepDepth } from '../../config/sweep.js';

export interface ParsedCurl {
  requestUrl: string;
  headers: Record<string, string>;
  cookieString: string;
  body: string;
}

export interface FormOverrideChange {
  key: string;
  from: string;
  to: string;
}

export interface BootstrapFormParamsResult {
  params: URLSearchParams;
  changedKeys: FormOverrideChange[];
  skippedKeys: string[];
}

export interface ViewStates {
  viewState: string;
  newViewState: string;
}

export interface PageInfo {
  currentPage: number;
  totalPages: number;
}

export interface ProductRow {
  page: number;
  ean_plu: string;
  root_article_code: string;
  lu: string;
  lv: string;
  sv_code: string;
  description: string;
  size: string;
  must_stock: string;
  delisted: string;
  store_selling_price: string;
  cost_price: string;
  vat: string;
  case_qty: string;
  margin_percent: string;
  drs: string;
  supplier: string;
  article_linking: string;
  department?: string;
  subdepartment?: string;
  commodity_code?: string;
  family_group?: string;
}

export interface ScrapePageInfo {
  currentPage: number;
  totalPages: number;
}

export interface ScrapeReplayInput {
  requestUrl: string;
  requestHeaders: Record<string, string>;
  cookieString: string;
  bootstrapBody: string;
  delayMs: number;
  maxPages?: number | null;
  abortSignal?: AbortSignal;
}

export interface ScrapeReplayHooks {
  collectRows?: boolean;
  phasePrefix?: string;
  logLabel?: string;
  allowEmptyReport?: boolean;
  onPageRows?: (rows: ProductRow[], page: ScrapePageInfo) => Promise<void> | void;
}

export interface ScrapeReplayResult {
  rows: ProductRow[];
  totalRows: number;
  pagesScraped: number[];
  rowsPerPage: Record<number, number>;
  diagnostics: {
    hasProductTableHeader: boolean;
    rowCandidateCount: number;
    debugResponsePath?: string;
    debugReportHtmlPath?: string;
  };
}

export interface ScrapeOptions {
  curlFile: string;
  outputCsvFile: string;
  maxPages: number | null;
  requestDelayMs: number | null;
  skipFormOverrides: boolean;
  help?: boolean;
}

export interface SweepLimits {
  maxStores: number | null;
  maxDepartments: number | null;
  maxSubdepartments: number | null;
  maxCommodities: number | null;
  maxFamilies: number | null;
}

export interface SweepOption {
  value: string;
  text: string;
}

export type SweepResumeLevel = 'department' | 'subdepartment' | 'commodity' | 'family';

export interface SweepResumeCheckpoint {
  option: SweepOption;
  index: number;
}

export interface SweepResumeCursor {
  store: SweepResumeCheckpoint;
  department?: SweepResumeCheckpoint;
  subdepartment?: SweepResumeCheckpoint;
  commodity?: SweepResumeCheckpoint;
  family?: SweepResumeCheckpoint;
  skipLevel: SweepResumeLevel;
  reason: string;
}

export interface SweepSelectionContext {
  store: SweepOption;
  department: SweepOption;
  subdepartment: SweepOption;
  commodity: SweepOption;
  family?: SweepOption;
}

export interface SweepStats {
  storesProcessed: number;
  combinationsVisited: number;
  combinationsScraped: number;
  combinationsFailed: number;
  rowsWritten: number;
  pageRequests: number;
}

export interface ScrapeAllOptions {
  reportUrl: string;
  outputCsvFile: string;
  chromePath: string;
  userDataDir: string;
  headless: boolean;
  timeoutMs: number;
  autoLogin: boolean;
  username: string;
  password: string;
  keepSignedIn: boolean;
  selectDelayMs: number;
  browserActionTimeoutMs: number;
  selectPostbackTimeoutMs: number;
  freshProfile: boolean;
  renderTimeoutMs: number;
  postRenderCaptureWaitMs: number;
  preferredCaptureTimeoutMs: number;
  forcedAsyncRetries: number;
  requestDelayMs: number;
  sweepDepth: SweepDepth;
  maxStores: number | null;
  maxDepartments: number | null;
  maxSubdepartments: number | null;
  maxCommodities: number | null;
  maxFamilies: number | null;
  parallel: boolean;
  maxParallelTabs: number | null;
  help?: boolean;
}

export interface ParallelStoreResult {
  storeName: string;
  storeValue: string;
  csvPath: string;
  stats: SweepStats;
  error?: string;
}
