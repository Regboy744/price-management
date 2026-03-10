import type { SweepOption } from '../../scrape/types.js';

export interface CaptureJobRequest {
  reportUrl?: string;
  chromePath?: string;
  userDataDir?: string;
  headless?: boolean;
  autoLogin?: boolean;
  username?: string;
  password?: string;
  keepSignedIn?: boolean;
  applySelects?: boolean;
  selectDelayMs?: number;
  browserActionTimeoutMs?: number;
  selectPostbackTimeoutMs?: number;
  timeoutMs?: number;
  freshProfile?: boolean;
  renderTimeoutMs?: number;
  postRenderCaptureWaitMs?: number;
  preferredCaptureTimeoutMs?: number;
  forcedAsyncRetries?: number;
  outputFileName?: string;
}

export interface CaptureJobResult {
  purpose: 'bootstrap-payload-capture';
  reportSurfaceUrl: string;
  selectedRequestUrl: string;
  selectedCurlPath: string;
  selectedBootstrapSource: string;
  selectedCaptureSequence: number;
  selectedEventTarget: string;
  captureCount: number;
  forcedAsyncAttemptCount: number;
  forcedAsyncResults: string[];
  payloadCount: number;
  payloadIndexPath: string;
  curlBundlePath: string;
  nextRecommendedJob: 'replay' | 'sweep';
  selection?: {
    store: SweepOption;
    department: SweepOption;
    subdepartment: SweepOption;
    commodity: SweepOption;
    family: SweepOption;
  };
}
