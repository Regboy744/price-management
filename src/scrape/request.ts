import axios, { type AxiosResponse } from 'axios';
import { logWarn } from '../runtime-log.js';
import {
  isAbortError,
  sleepWithAbort,
  throwIfAborted,
  toAbortError,
} from '../utils.js';

const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 45_000;
const DEFAULT_HTTP_REQUEST_RETRIES = 2;
const DEFAULT_HTTP_REQUEST_RETRY_DELAY_MS = 400;

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

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetriableRequestError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const status = error.response?.status;
  if (status !== undefined && isRetriableStatus(status)) {
    return true;
  }

  const code = String(error.code || '').toLowerCase();
  if (
    [
      'econnaborted',
      'econnreset',
      'etimedout',
      'eai_again',
      'err_network',
      'socket hang up',
    ].includes(code)
  ) {
    return true;
  }

  const message = String(error.message || '').toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('socket hang up') ||
    message.includes('network error')
  );
}

export async function sendRequest(
  url: string,
  headers: Record<string, string>,
  body: string,
  abortSignal?: AbortSignal
): Promise<AxiosResponse<string>> {
  throwIfAborted(abortSignal, 'SSRS request aborted');

  const timeoutMs = Math.max(
    5_000,
    envNonNegativeInteger('HTTP_REQUEST_TIMEOUT_MS', DEFAULT_HTTP_REQUEST_TIMEOUT_MS)
  );
  const retries = Math.max(0, envNonNegativeInteger('HTTP_REQUEST_RETRIES', DEFAULT_HTTP_REQUEST_RETRIES));
  const retryDelayMs = Math.max(
    0,
    envNonNegativeInteger('HTTP_REQUEST_RETRY_DELAY_MS', DEFAULT_HTTP_REQUEST_RETRY_DELAY_MS)
  );

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const response = await axios.post<string>(url, body, {
        headers,
        timeout: timeoutMs,
        signal: abortSignal,
        maxRedirects: 0,
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [(raw) => raw],
      });

      throwIfAborted(abortSignal, 'SSRS request aborted');

      const retryableStatus = isRetriableStatus(response.status);
      const shouldRetry = retryableStatus && attempt <= retries;

      if (shouldRetry) {
        const backoffMs = retryDelayMs * attempt;
        logWarn(
          `HTTP ${response.status} from SSRS request (attempt ${attempt}/${retries + 1}), retrying in ${backoffMs}ms...`
        );
        await sleepWithAbort(backoffMs, abortSignal, 'SSRS request aborted');
        continue;
      }

      return response;
    } catch (error) {
      if (abortSignal?.aborted || isAbortError(error)) {
        throw toAbortError(abortSignal?.reason ?? error, 'SSRS request aborted');
      }

      lastError = error;

      const shouldRetry = attempt <= retries && isRetriableRequestError(error);
      if (!shouldRetry) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`HTTP request failed on attempt ${attempt}/${retries + 1}: ${message}`);
      }

      const message = error instanceof Error ? error.message : String(error);
      const backoffMs = retryDelayMs * attempt;
      logWarn(
        `HTTP request transient failure on attempt ${attempt}/${retries + 1}: ${message}. Retrying in ${backoffMs}ms...`
      );
      await sleepWithAbort(backoffMs, abortSignal, 'SSRS request aborted');
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`HTTP request failed after ${retries + 1} attempts: ${message}`);
}
