import type { ElementHandle } from 'playwright-core';

export interface DropdownStep {
  label: string;
  key: string;
  selector: string;
  value: string;
  waitForPostback: boolean;
}

export interface CaptureOptions {
  reportUrl: string;
  sessionFile: string;
  chromePath: string;
  userDataDir: string;
  headless: boolean;
  timeoutMs: number;
  autoLogin: boolean;
  username: string;
  password: string;
  keepSignedIn: boolean;
  applySelects: boolean;
  selectDelayMs: number;
  browserActionTimeoutMs: number;
  selectPostbackTimeoutMs: number;
  freshProfile: boolean;
  renderTimeoutMs: number;
  postRenderCaptureWaitMs: number;
  preferredCaptureTimeoutMs: number;
  forcedAsyncRetries: number;
  help?: boolean;
}

export interface NetworkCapture {
  sequence: number;
  requestUrl: string;
  method: string;
  requestHeaders: Record<string, string>;
  cookieString: string;
  bootstrapDataRaw: string;
  initialViewState: string;
  capturedAt: string;
  eventTarget: string;
  currentPage: string;
}

export interface SessionOutput {
  cookieString: string;
  requestUrl: string;
  bootstrapDataRaw: string;
  initialViewState: string;
}

export interface AuthSurfaceState {
  currentUrl: string;
  isLoginHost: boolean;
  hasUsernameField: boolean;
  hasPasswordField: boolean;
  hasReportForm: boolean;
  hasReportViewerControl: boolean;
}

export interface ReportPageState {
  visibilityState: string;
  pageUrl: string;
  hasReportTitle: boolean;
  hasEanHeader: boolean;
}

export interface ReportSurfaceState {
  currentUrl: string;
  isLoginHost: boolean;
  hasReportForm: boolean;
  hasReportViewerControl: boolean;
  title: string;
}

export interface SelectorMatch {
  selector: string;
  handle: ElementHandle;
}

export interface SelectOption {
  value: string;
  text: string;
  selected: boolean;
}

export interface SelectedOption {
  value: string;
  text: string;
}

export interface DropdownWorkflowResult {
  beforeViewReportCaptureCount: number;
  captureCountAtRenderComplete?: number;
  captureCountAfterPostRenderWait?: number;
  renderCompletedAt?: string;
  reportState?: ReportPageState;
}

export interface PreferredCaptureResult {
  selectedCapture: NetworkCapture | null;
  selectedBootstrapSource: string;
  forcedAsyncAttemptCount: number;
  forcedAsyncResults: string[];
}

export interface CaptureDiagnostics {
  capturesAfterViewReportCount: number;
  preferredCapturesAfterViewReportCount: number;
  eventTargetsAfterViewReport: string[];
}

export interface PayloadRecord {
  sequence: number;
  capturedAt: string;
  requestUrl: string;
  eventTarget: string;
  ajaxScriptManager: string;
  currentPage: string;
  bodyLength: number;
  hasViewState: boolean;
  hasNewViewState: boolean;
  preferred: boolean;
  payloadFile: string;
  curlFile: string;
}

export interface ExtractedSession {
  requestUrl: string;
  cookieString: string;
  bootstrapDataRaw: string;
  initialViewState: string;
  capturedAt: string;
  pageUrl: string;
  pageTitle: string;
  formAction: string;
  html: string;
  hasForm: boolean;
}

export interface CaptureStats {
  retainedCount: number;
  retainedBytes: number;
  droppedCount: number;
  droppedBytes: number;
  maxItems: number;
  maxBytes: number;
}

export interface BrowserContext {
  captures: NetworkCapture[];
  getCaptureCount: () => number;
  clearCaptures: () => void;
  detachCapture: () => void;
  getCaptureStats: () => CaptureStats;
}
