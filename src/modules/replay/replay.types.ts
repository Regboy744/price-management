export interface ReplayJobRequest {
  curlFile?: string;
  captureJobId?: string;
  outputFileName?: string;
  maxPages?: number;
  requestDelayMs?: number;
  applyFormOverrides?: boolean;
}

export interface ReplayJobExecutionInput {
  curlFilePath: string;
  sourceDescription: string;
  captureJobId?: string;
  outputFileName?: string;
  maxPages?: number;
  requestDelayMs?: number;
  applyFormOverrides?: boolean;
}

export interface ReplayJobResult {
  curlFilePath: string;
  outputCsvPath: string;
  requestUrl: string;
  totalRows: number;
  pageCount: number;
  pagesScraped: number[];
  rowsPerPage: Record<number, number>;
  requestDelayMs: number;
  sourceDescription: string;
  appliedFormOverrides: boolean;
  changedKeys: number;
  skippedKeys: number;
}
