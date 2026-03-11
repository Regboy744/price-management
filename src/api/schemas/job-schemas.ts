import { ValidationError } from '../../shared/errors/app-error.js';
import type { SweepJobRequest } from '../../modules/sweep/sweep.types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isPlainObject(value)) {
    throw new ValidationError('Request body must be a JSON object.');
  }

  return value;
}

function readOptionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new ValidationError(`${key} must be a string.`);
  }

  return value.trim() || undefined;
}

function readOptionalBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  throw new ValidationError(`${key} must be a boolean.`);
}

function readOptionalInteger(
  source: Record<string, unknown>,
  key: string,
  minimum: number
): number | undefined {
  const value = source[key];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < minimum) {
    throw new ValidationError(`${key} must be an integer greater than or equal to ${minimum}.`);
  }

  return parsed;
}

function readOptionalStringList(source: Record<string, unknown>, key: string): string[] | undefined {
  const value = source[key];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const rawItems = Array.isArray(value) ? value : [value];
  const normalizedItems: string[] = [];

  for (const item of rawItems) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      throw new ValidationError(`${key} must be a string, number, or array of strings/numbers.`);
    }

    const itemText = String(item).trim();
    if (!itemText) {
      continue;
    }

    for (const part of itemText.split(',')) {
      const normalized = part.trim();
      if (normalized) {
        normalizedItems.push(normalized);
      }
    }
  }

  if (!normalizedItems.length) {
    return undefined;
  }

  return [...new Set(normalizedItems)];
}

export function parseSweepJobRequest(body: unknown): SweepJobRequest {
  const source = asObject(body);

  return {
    reportUrl: readOptionalString(source, 'reportUrl'),
    chromePath: readOptionalString(source, 'chromePath'),
    userDataDir: readOptionalString(source, 'userDataDir'),
    headless: readOptionalBoolean(source, 'headless'),
    autoLogin: readOptionalBoolean(source, 'autoLogin'),
    username: readOptionalString(source, 'username'),
    password: readOptionalString(source, 'password'),
    keepSignedIn: readOptionalBoolean(source, 'keepSignedIn'),
    timeoutMs: readOptionalInteger(source, 'timeoutMs', 1),
    selectDelayMs: readOptionalInteger(source, 'selectDelayMs', 0),
    browserActionTimeoutMs: readOptionalInteger(source, 'browserActionTimeoutMs', 1),
    selectPostbackTimeoutMs: readOptionalInteger(source, 'selectPostbackTimeoutMs', 0),
    freshProfile: readOptionalBoolean(source, 'freshProfile'),
    renderTimeoutMs: readOptionalInteger(source, 'renderTimeoutMs', 1),
    postRenderCaptureWaitMs: readOptionalInteger(source, 'postRenderCaptureWaitMs', 0),
    preferredCaptureTimeoutMs: readOptionalInteger(source, 'preferredCaptureTimeoutMs', 0),
    forcedAsyncRetries: readOptionalInteger(source, 'forcedAsyncRetries', 0),
    requestDelayMs: readOptionalInteger(source, 'requestDelayMs', 0),
    stores: readOptionalStringList(source, 'stores'),
    maxStores: readOptionalInteger(source, 'maxStores', 1),
    maxDepartments: readOptionalInteger(source, 'maxDepartments', 1),
    maxSubdepartments: readOptionalInteger(source, 'maxSubdepartments', 1),
    maxCommodities: readOptionalInteger(source, 'maxCommodities', 1),
    maxFamilies: readOptionalInteger(source, 'maxFamilies', 1),
    parallel: readOptionalBoolean(source, 'parallel'),
    maxParallelTabs: readOptionalInteger(source, 'maxParallelTabs', 1),
    outputFileName: readOptionalString(source, 'outputFileName'),
  };
}
