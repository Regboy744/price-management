import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { fixedSelections, startFromSecondSelections, sweepFields } from '../../config/sweep.js';
import { VIEW_REPORT_BUTTON_SELECTOR } from '../../config/report.js';
import type { CaptureOptions, CaptureStats, NetworkCapture, SelectOption } from '../types.js';
import {
  findFirstSelector,
  getHiddenFieldValue,
  getSelectOptions,
  getSelectedOption,
  waitForDropdownEnabled,
  waitForPostbackOrStateChange,
} from '../dom.js';
import { waitForReportPageState, waitForReportSurface, ensurePreferredCapture, pickLatestUsableCapture } from '../report.js';
import {
  resolveBrowserActionTimeoutMs,
  sleepWithAbort,
  throwIfAborted,
  TimedActionError,
  withTimeout,
} from '../utils.js';
import type { ProductsCsvAppender } from './output.js';
import { scrapeFromBootstrap } from './runner.js';
import type {
  ProductRow,
  ScrapePageInfo,
  SweepLimits,
  SweepResumeCheckpoint,
  SweepResumeCursor,
  SweepResumeLevel,
  SweepOption,
  SweepSelectionContext,
  SweepStats,
} from './types.js';

interface SweepRunInput {
  page: Page;
  captures: NetworkCapture[];
  getCaptureCount: () => number;
  clearCaptures?: () => void;
  getCaptureStats?: () => CaptureStats;
  abortSignal?: AbortSignal;
  captureOptions: CaptureOptions;
  requestDelayMs: number;
  limits: SweepLimits;
  csvAppender: ProductsCsvAppender;
  errorLogPath: string;
  storeCandidates?: SweepOption[];
  logPrefix?: string;
  stats?: SweepStats;
  resumeAfter?: SweepResumeCursor | null;
  throwOnFreeze?: boolean;
}

interface OptionSet {
  all: SweepOption[];
  iterate: SweepOption[];
}

type ResumePathLevel = 'store' | SweepResumeLevel;

interface ResumePathContext {
  store: SweepResumeCheckpoint;
  department?: SweepResumeCheckpoint;
  subdepartment?: SweepResumeCheckpoint;
  commodity?: SweepResumeCheckpoint;
  family?: SweepResumeCheckpoint;
}

interface ResumeStartInfo {
  startIndex: number;
  carryResume: boolean;
  resumeIndex: number | null;
}

export class SweepResumeRequiredError extends Error {
  readonly resumeAfter: SweepResumeCursor;

  constructor(resumeAfter: SweepResumeCursor) {
    super(
      `Fresh-tab resume required after ${resumeAfter.skipLevel} ${resumeAfter[resumeAfter.skipLevel]?.option.text || '(unknown)'}: ${resumeAfter.reason}`
    );
    this.name = 'SweepResumeRequiredError';
    this.resumeAfter = resumeAfter;
  }
}

const DEFAULT_FAMILY_SELECT_TIMEOUT_MS = 5_000;

function readFamilySelectTimeoutMs(): number {
  const raw = process.env['FAMILY_SELECT_TIMEOUT_MS'];
  if (raw === undefined || raw === null || raw.trim() === '') {
    return DEFAULT_FAMILY_SELECT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_FAMILY_SELECT_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

function toSweepOptions(options: SelectOption[]): SweepOption[] {
  return options
    .filter((option) => option.value.trim().length > 0)
    .map((option) => ({
      value: option.value,
      text: option.text,
    }));
}

function limitOptions(options: SweepOption[], max: number | null): SweepOption[] {
  if (max === null) {
    return options;
  }
  return options.slice(0, Math.max(0, max));
}

function appendError(errorLogPath: string, message: string): void {
  fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });
  fs.appendFileSync(errorLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

function throwIfSweepAborted(
  input: SweepRunInput,
  fallbackMessage = 'Sweep aborted'
): void {
  throwIfAborted(input.abortSignal, fallbackMessage);
}

function isRetriableSweepError(message: string): boolean {
  const normalized = String(message || '').toLowerCase();

  return [
    'timeout',
    'timed out',
    'target page, context or browser has been closed',
    'execution context was destroyed',
    'frame was detached',
    'navigation failed',
    'net::',
    'protocol error',
    'connection closed',
    'econnreset',
    'etimedout',
    'eai_again',
    'socket hang up',
  ].some((token) => normalized.includes(token));
}

function isPageBrokenError(message: string): boolean {
  const normalized = String(message || '').toLowerCase();
  return (
    normalized.includes('dropdown stayed disabled') ||
    normalized.includes('error state after view report') ||
    normalized.includes('report viewer returned error')
  );
}

function isResumeSelectionError(error: unknown): boolean {
  if (error instanceof TimedActionError) {
    return true;
  }

  const normalized = String(error instanceof Error ? error.message : error || '').toLowerCase();
  return (
    normalized.includes(' is not available') ||
    normalized.includes('selection did not stick') ||
    normalized.includes('dropdown stayed disabled') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout')
  );
}

function isResumeCombinationError(error: unknown): boolean {
  if (error instanceof TimedActionError) {
    return true;
  }

  const normalized = String(error instanceof Error ? error.message : error || '').toLowerCase();
  return normalized.includes('timed out') || normalized.includes('timeout');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFamilyDropdownTimeoutMessage(message: string): boolean {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('read dropdown state #reportviewercontrol_ctl04_ctl27_ddvalue timed out');
}

function isFamilyRenderTimeoutMessage(message: string): boolean {
  const normalized = String(message || '').toLowerCase();
  return (
    normalized.includes('read hidden field #__viewstate timed out') ||
    normalized.includes('read report page state timed out') ||
    normalized.includes('timed out waiting for report render markers after view report click')
  );
}

function isSkippableFamilyFailure(error: unknown): boolean {
  const message = toErrorMessage(error);
  const normalized = message.toLowerCase();

  return (
    isPageBrokenError(message) ||
    isFamilyDropdownTimeoutMessage(message) ||
    isFamilyRenderTimeoutMessage(message) ||
    (normalized.includes('family group:') &&
      (normalized.includes(' is not available') ||
        normalized.includes('selection did not stick') ||
        normalized.includes('dropdown stayed disabled') ||
        normalized.includes('timed out') ||
        normalized.includes('timeout')))
  );
}

function createEmptyStats(): SweepStats {
  return {
    storesProcessed: 0,
    combinationsVisited: 0,
    combinationsScraped: 0,
    combinationsFailed: 0,
    rowsWritten: 0,
    pageRequests: 0,
  };
}

/**
 * Copy the current dropdown selections into each scraped row so CSV output can
 * include hierarchy columns without changing the parser responsibilities.
 */
function enrichRowsWithSelectionContext(
  rows: ProductRow[],
  selection: SweepSelectionContext
): ProductRow[] {
  if (!rows.length) {
    return rows;
  }

  const rowContext = {
    department: selection.department.text,
    subdepartment: selection.subdepartment.text,
    commodity_code: selection.commodity.text,
    family_group: selection.family.text,
  };

  return rows.map((row) => ({
    ...row,
    ...rowContext,
  }));
}

function createResumeCheckpoint(option: SweepOption, index: number): SweepResumeCheckpoint {
  return {
    option: {
      value: option.value,
      text: option.text,
    },
    index,
  };
}

function createResumeCursor(
  path: ResumePathContext,
  skipLevel: SweepResumeLevel,
  reason: string
): SweepResumeCursor {
  return {
    store: createResumeCheckpoint(path.store.option, path.store.index),
    department: path.department
      ? createResumeCheckpoint(path.department.option, path.department.index)
      : undefined,
    subdepartment: path.subdepartment
      ? createResumeCheckpoint(path.subdepartment.option, path.subdepartment.index)
      : undefined,
    commodity: path.commodity
      ? createResumeCheckpoint(path.commodity.option, path.commodity.index)
      : undefined,
    family: path.family ? createResumeCheckpoint(path.family.option, path.family.index) : undefined,
    skipLevel,
    reason,
  };
}

function getResumeCheckpoint(
  resume: SweepResumeCursor | null | undefined,
  level: ResumePathLevel
): SweepResumeCheckpoint | undefined {
  if (!resume) {
    return undefined;
  }

  if (level === 'store') {
    return resume.store;
  }

  return resume[level];
}

function getResumeStartInfo(
  level: ResumePathLevel,
  options: SweepOption[],
  resume: SweepResumeCursor | null | undefined
): ResumeStartInfo {
  const checkpoint = getResumeCheckpoint(resume, level);
  if (!checkpoint) {
    return {
      startIndex: 0,
      carryResume: false,
      resumeIndex: null,
    };
  }

  const foundIndex = options.findIndex((option) => option.value === checkpoint.option.value);
  const fallbackIndex = Math.min(Math.max(0, checkpoint.index), options.length);

  if (level !== 'store' && resume?.skipLevel === level) {
    return {
      startIndex: foundIndex >= 0 ? foundIndex + 1 : fallbackIndex,
      carryResume: false,
      resumeIndex: null,
    };
  }

  if (foundIndex >= 0) {
    return {
      startIndex: foundIndex,
      carryResume: true,
      resumeIndex: foundIndex,
    };
  }

  return {
    startIndex: fallbackIndex,
    carryResume: false,
    resumeIndex: null,
  };
}

function selectionPathLabel(selections: {
  store?: SweepOption;
  department?: SweepOption;
  subdepartment?: SweepOption;
  commodity?: SweepOption;
  family?: SweepOption;
}): string {
  return [
    selections.store?.text,
    selections.department?.text,
    selections.subdepartment?.text,
    selections.commodity?.text,
    selections.family?.text,
  ]
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .join(' > ');
}

function throwFreshTabResume(
  input: SweepRunInput,
  cursor: SweepResumeCursor,
  selections: {
    store?: SweepOption;
    department?: SweepOption;
    subdepartment?: SweepOption;
    commodity?: SweepOption;
    family?: SweepOption;
  }
): never {
  const prefix = input.logPrefix ? `${input.logPrefix} ` : '';
  const path = selectionPathLabel(selections) || '(unknown selection)';
  const line = `[${path}] ${cursor.reason}`;
  console.warn(`${prefix}Fresh-tab resume requested: ${line}`);
  appendError(input.errorLogPath, `[resume] ${line}`);
  throw new SweepResumeRequiredError(cursor);
}

async function recoverPage(
  page: Page,
  reportUrl: string,
  prefix: string,
  abortSignal?: AbortSignal
): Promise<boolean> {
  try {
    throwIfAborted(abortSignal, `${prefix}Page recovery aborted.`);
    console.log(`${prefix}Recovering page after SSRS error (reloading report)...`);
    await page.goto(reportUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    const surface = await waitForReportSurface(page, 45_000, 15_000, abortSignal);
    if (!surface) {
      console.error(`${prefix}Recovery failed: report surface not detected after reload.`);
      return false;
    }
    console.log(`${prefix}Page recovered, report surface ready.`);
    return true;
  } catch (error) {
    throwIfAborted(abortSignal, `${prefix}Page recovery aborted.`);

    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${prefix}Recovery failed: ${msg}`);
    return false;
  }
}

interface RecoverySelections {
  store: SweepOption;
  department?: SweepOption;
  subdepartment?: SweepOption;
  commodity?: SweepOption;
}

async function reapplySelections(
  input: SweepRunInput,
  selections: RecoverySelections,
  prefix: string
): Promise<boolean> {
  try {
    throwIfSweepAborted(input, `${prefix}Selection re-apply aborted.`);
    console.log(`${prefix}Re-applying selections after recovery...`);

    await ensureDropdownSelection(
      input.page,
      input,
      sweepFields.store.selector,
      sweepFields.store.label,
      selections.store.value,
      sweepFields.store.waitForPostback
    );

    await applyFixedFilters(input);

    if (selections.department) {
      await ensureDropdownSelection(
        input.page,
        input,
        sweepFields.department.selector,
        sweepFields.department.label,
        selections.department.value,
        sweepFields.department.waitForPostback
      );
    }

    if (selections.subdepartment) {
      await ensureDropdownSelection(
        input.page,
        input,
        sweepFields.subdepartment.selector,
        sweepFields.subdepartment.label,
        selections.subdepartment.value,
        sweepFields.subdepartment.waitForPostback
      );
    }

    if (selections.commodity) {
      await ensureDropdownSelection(
        input.page,
        input,
        sweepFields.commodity.selector,
        sweepFields.commodity.label,
        selections.commodity.value,
        sweepFields.commodity.waitForPostback
      );
    }

    console.log(`${prefix}Selections re-applied successfully.`);
    return true;
  } catch (error) {
    throwIfSweepAborted(input, `${prefix}Selection re-apply aborted.`);

    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${prefix}Failed to re-apply selections: ${msg}`);
    return false;
  }
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function maybeLogSweepTelemetry(prefix: string, stats: SweepStats, input: SweepRunInput): void {
  if (stats.combinationsVisited === 0 || stats.combinationsVisited % 20 !== 0) {
    return;
  }

  const memory = process.memoryUsage();
  const captureStats = input.getCaptureStats ? input.getCaptureStats() : null;

  if (captureStats) {
    const maxBytesText =
      captureStats.maxBytes === Number.MAX_SAFE_INTEGER
        ? 'unbounded'
        : `${formatMb(captureStats.maxBytes)}MB`;

    console.log(
      `${prefix}[telemetry] combos=${stats.combinationsVisited} rss=${formatMb(memory.rss)}MB heap=${formatMb(memory.heapUsed)}MB captures=${captureStats.retainedCount}/${captureStats.maxItems} capBytes=${formatMb(captureStats.retainedBytes)}MB capLimit=${maxBytesText} dropped=${captureStats.droppedCount}`
    );
    return;
  }

  console.log(
    `${prefix}[telemetry] combos=${stats.combinationsVisited} rss=${formatMb(memory.rss)}MB heap=${formatMb(memory.heapUsed)}MB`
  );
}

function selectionLabel(selection: SweepSelectionContext): string {
  return `${selection.store.text} > ${selection.department.text} > ${selection.subdepartment.text} > ${selection.commodity.text} > ${selection.family.text}`;
}

async function resolveOptions(
  page: Page,
  selector: string,
  startFromSecond: boolean,
  maxItems: number | null,
  actionTimeoutMs: number,
  abortSignal?: AbortSignal
): Promise<OptionSet> {
  throwIfAborted(abortSignal, `Option resolution aborted: ${selector}`);

  const enabled = await waitForDropdownEnabled(
    page,
    selector,
    45_000,
    actionTimeoutMs,
    abortSignal
  );
  if (!enabled) {
    throw new Error(`Dropdown stayed disabled: ${selector}`);
  }

  const options = toSweepOptions(await getSelectOptions(page, selector, actionTimeoutMs));
  if (!options.length) {
    throw new Error(`Dropdown has no selectable options: ${selector}`);
  }

  const iterStart = startFromSecond ? 1 : 0;
  return {
    all: options,
    iterate: limitOptions(options.slice(iterStart), maxItems),
  };
}

async function ensureDropdownSelection(
  page: Page,
  input: SweepRunInput,
  selector: string,
  label: string,
  targetValue: string,
  waitForPostback: boolean
): Promise<SweepOption> {
  throwIfSweepAborted(input, `${label}: selection aborted`);

  const actionTimeoutMs = resolveBrowserActionTimeoutMs(input.captureOptions);

  const enabled = await waitForDropdownEnabled(
    page,
    selector,
    45_000,
    actionTimeoutMs,
    input.abortSignal
  );
  if (!enabled) {
    throw new Error(`${label}: dropdown stayed disabled (${selector})`);
  }

  const options = toSweepOptions(await getSelectOptions(page, selector, actionTimeoutMs));
  const target = options.find((option) => option.value === targetValue);

  if (!target) {
    const available = options.map((option) => option.value).join(', ');
    throw new Error(`${label}: value ${targetValue} is not available. Found: ${available}`);
  }

  const current = await getSelectedOption(page, selector, actionTimeoutMs);
  if (current.value !== targetValue) {
    const beforeCaptureCount = input.getCaptureCount();
    const beforeViewState = await getHiddenFieldValue(page, '#__VIEWSTATE', actionTimeoutMs);

    await withTimeout(
      page.selectOption(selector, targetValue),
      actionTimeoutMs,
      () => new TimedActionError(`${label} select action`, actionTimeoutMs)
    );

    if (waitForPostback) {
      const result = await waitForPostbackOrStateChange(
        page,
        beforeCaptureCount,
        input.getCaptureCount,
        beforeViewState,
        Math.max(1_000, input.captureOptions.selectPostbackTimeoutMs),
        actionTimeoutMs,
        input.abortSignal
      );

      if (result === 'timeout') {
        console.warn(`${label}: no postback/state change detected, continuing.`);
      }
    } else {
      await sleepWithAbort(150, input.abortSignal, `${label}: selection aborted`);
    }
  }

  const selected = await getSelectedOption(page, selector, actionTimeoutMs);
  if (selected.value !== targetValue) {
    throw new Error(`${label}: selection did not stick (target=${targetValue}, actual=${selected.value || 'none'})`);
  }

  await sleepWithAbort(
    Math.max(0, input.captureOptions.selectDelayMs),
    input.abortSignal,
    `${label}: selection aborted`
  );
  return {
    value: selected.value,
    text: selected.text || target.text,
  };
}

async function applyFixedFilters(input: SweepRunInput): Promise<void> {
  await ensureDropdownSelection(
    input.page,
    input,
    sweepFields.saleable.selector,
    sweepFields.saleable.label,
    fixedSelections.saleable,
    sweepFields.saleable.waitForPostback
  );
  await ensureDropdownSelection(
    input.page,
    input,
    sweepFields.orderable.selector,
    sweepFields.orderable.label,
    fixedSelections.orderable,
    sweepFields.orderable.waitForPostback
  );
  await ensureDropdownSelection(
    input.page,
    input,
    sweepFields.mainSupplierOnly.selector,
    sweepFields.mainSupplierOnly.label,
    fixedSelections.mainSupplierOnly,
    sweepFields.mainSupplierOnly.waitForPostback
  );
  await ensureDropdownSelection(
    input.page,
    input,
    sweepFields.suppliers.selector,
    sweepFields.suppliers.label,
    fixedSelections.suppliers,
    sweepFields.suppliers.waitForPostback
  );
}

async function ensureExpand(input: SweepRunInput): Promise<void> {
  await ensureDropdownSelection(
    input.page,
    input,
    sweepFields.expand.selector,
    sweepFields.expand.label,
    fixedSelections.expand,
    sweepFields.expand.waitForPostback
  );
}

async function clickViewReport(
  page: Page,
  actionTimeoutMs: number,
  abortSignal?: AbortSignal
): Promise<void> {
  throwIfAborted(abortSignal, 'View Report aborted');

  const buttonMatch = await findFirstSelector(
    page,
    [VIEW_REPORT_BUTTON_SELECTOR],
    20_000,
    actionTimeoutMs,
    abortSignal
  );
  if (!buttonMatch) {
    throw new Error('View Report button not found.');
  }

  const enabled = await withTimeout(
    page.$eval(VIEW_REPORT_BUTTON_SELECTOR, (button) => !(button as HTMLButtonElement).disabled),
    actionTimeoutMs,
    () => new TimedActionError('View Report enabled check', actionTimeoutMs)
  ).catch((error) => {
    if (error instanceof TimedActionError) {
      throw error;
    }
    return false;
  });

  if (!enabled) {
    throw new Error('View Report button is disabled.');
  }

  await withTimeout(
    buttonMatch.handle.click(),
    actionTimeoutMs,
    () => new TimedActionError('View Report click', actionTimeoutMs)
  );
  await sleepWithAbort(200, abortSignal, 'View Report aborted');
}

function logOptions(
  label: string,
  optionSet: OptionSet,
  startFromSecond: boolean,
  prefix = ''
): void {
  const rule = startFromSecond ? 'start-from-second' : 'start-from-first';
  console.log(
    `${prefix}${label}: options=${optionSet.all.length}, iterating=${optionSet.iterate.length} (${rule})`
  );
}

export async function runCascadedSweep(input: SweepRunInput): Promise<SweepStats> {
  throwIfSweepAborted(input);

  const prefix = input.logPrefix ? `${input.logPrefix} ` : '';
  const stats = input.stats ?? createEmptyStats();
  const initialResume = input.resumeAfter ?? null;
  const actionTimeoutMs = resolveBrowserActionTimeoutMs(input.captureOptions);

  let storeCandidates: SweepOption[];

  if (input.storeCandidates) {
    storeCandidates = input.storeCandidates;
    console.log(`${prefix}${sweepFields.store.label}: assigned=${storeCandidates.length}`);
  } else {
    const storeOptionSet = await resolveOptions(
      input.page,
      sweepFields.store.selector,
      false,
      input.limits.maxStores,
      actionTimeoutMs,
      input.abortSignal
    );
    logOptions(sweepFields.store.label, storeOptionSet, false, prefix);
    storeCandidates = storeOptionSet.iterate;
  }

  const storeResumeInfo = getResumeStartInfo('store', storeCandidates, initialResume);

  for (let storeIndex = storeResumeInfo.startIndex; storeIndex < storeCandidates.length; storeIndex += 1) {
    throwIfSweepAborted(input);

    const storeCandidate = storeCandidates[storeIndex]!;
    const storeResume =
      storeResumeInfo.carryResume && storeResumeInfo.resumeIndex === storeIndex ? initialResume : null;

    const store = await ensureDropdownSelection(
      input.page,
      input,
      sweepFields.store.selector,
      sweepFields.store.label,
      storeCandidate.value,
      sweepFields.store.waitForPostback
    );

    if (!storeResume) {
      stats.storesProcessed += 1;
    }
    console.log(`${prefix}Store selected: ${store.text}`);

    await applyFixedFilters(input);

    const departmentOptions = await resolveOptions(
      input.page,
      sweepFields.department.selector,
      startFromSecondSelections.department,
      input.limits.maxDepartments,
      actionTimeoutMs,
      input.abortSignal
    );
    logOptions(sweepFields.department.label, departmentOptions, true, prefix);

    if (!departmentOptions.iterate.length) {
      console.log(`${prefix}Skipping store ${store.text}: no departments to iterate.`);
      continue;
    }

    const departmentResumeInfo = getResumeStartInfo(
      'department',
      departmentOptions.iterate,
      storeResume
    );

    for (
      let departmentIndex = departmentResumeInfo.startIndex;
      departmentIndex < departmentOptions.iterate.length;
      departmentIndex += 1
    ) {
      throwIfSweepAborted(input);

      const departmentCandidate = departmentOptions.iterate[departmentIndex]!;
      let department: SweepOption;

      try {
        department = await ensureDropdownSelection(
          input.page,
          input,
          sweepFields.department.selector,
          sweepFields.department.label,
          departmentCandidate.value,
          sweepFields.department.waitForPostback
        );
      } catch (error) {
        throwIfSweepAborted(input, 'Department selection aborted');

        if (input.throwOnFreeze && isResumeSelectionError(error)) {
          throwFreshTabResume(
            input,
            createResumeCursor(
              {
                store: createResumeCheckpoint(store, storeIndex),
                department: createResumeCheckpoint(departmentCandidate, departmentIndex),
              },
              'department',
              error instanceof Error ? error.message : String(error)
            ),
            { store, department: departmentCandidate }
          );
        }
        throw error;
      }

      const departmentResume =
        departmentResumeInfo.carryResume && departmentResumeInfo.resumeIndex === departmentIndex
          ? storeResume
          : null;

      let subdepartmentOptions: OptionSet;

      try {
        subdepartmentOptions = await resolveOptions(
          input.page,
          sweepFields.subdepartment.selector,
          startFromSecondSelections.subdepartment,
          input.limits.maxSubdepartments,
          actionTimeoutMs,
          input.abortSignal
        );
      } catch (error) {
        throwIfSweepAborted(input, 'Subdepartment option resolution aborted');

        if (input.throwOnFreeze && isResumeSelectionError(error)) {
          throwFreshTabResume(
            input,
            createResumeCursor(
              {
                store: createResumeCheckpoint(store, storeIndex),
                department: createResumeCheckpoint(department, departmentIndex),
              },
              'department',
              error instanceof Error ? error.message : String(error)
            ),
            { store, department }
          );
        }
        throw error;
      }
      logOptions(sweepFields.subdepartment.label, subdepartmentOptions, true, prefix);

      if (!subdepartmentOptions.iterate.length) {
        console.log(
          `${prefix}Skipping ${store.text} > ${department.text}: no subdepartments to iterate.`
        );
        continue;
      }

      const subdepartmentResumeInfo = getResumeStartInfo(
        'subdepartment',
        subdepartmentOptions.iterate,
        departmentResume
      );

      for (
        let subdepartmentIndex = subdepartmentResumeInfo.startIndex;
        subdepartmentIndex < subdepartmentOptions.iterate.length;
        subdepartmentIndex += 1
      ) {
        throwIfSweepAborted(input);

        const subdepartmentCandidate = subdepartmentOptions.iterate[subdepartmentIndex]!;
        let subdepartment: SweepOption;

        try {
          subdepartment = await ensureDropdownSelection(
            input.page,
            input,
            sweepFields.subdepartment.selector,
            sweepFields.subdepartment.label,
            subdepartmentCandidate.value,
            sweepFields.subdepartment.waitForPostback
          );
        } catch (error) {
          throwIfSweepAborted(input, 'Subdepartment selection aborted');

          if (input.throwOnFreeze && isResumeSelectionError(error)) {
            throwFreshTabResume(
              input,
              createResumeCursor(
                {
                  store: createResumeCheckpoint(store, storeIndex),
                  department: createResumeCheckpoint(department, departmentIndex),
                  subdepartment: createResumeCheckpoint(subdepartmentCandidate, subdepartmentIndex),
                },
                'subdepartment',
                error instanceof Error ? error.message : String(error)
              ),
              { store, department, subdepartment: subdepartmentCandidate }
            );
          }
          throw error;
        }

        const subdepartmentResume =
          subdepartmentResumeInfo.carryResume &&
          subdepartmentResumeInfo.resumeIndex === subdepartmentIndex
            ? departmentResume
            : null;

        let commodityOptions: OptionSet;

        try {
          commodityOptions = await resolveOptions(
            input.page,
            sweepFields.commodity.selector,
            startFromSecondSelections.commodity,
            input.limits.maxCommodities,
            actionTimeoutMs,
            input.abortSignal
          );
        } catch (error) {
          throwIfSweepAborted(input, 'Commodity option resolution aborted');

          if (input.throwOnFreeze && isResumeSelectionError(error)) {
            throwFreshTabResume(
              input,
              createResumeCursor(
                {
                  store: createResumeCheckpoint(store, storeIndex),
                  department: createResumeCheckpoint(department, departmentIndex),
                  subdepartment: createResumeCheckpoint(subdepartment, subdepartmentIndex),
                },
                'subdepartment',
                error instanceof Error ? error.message : String(error)
              ),
              { store, department, subdepartment }
            );
          }
          throw error;
        }
        logOptions(sweepFields.commodity.label, commodityOptions, true, prefix);

        if (!commodityOptions.iterate.length) {
          console.log(
            `${prefix}Skipping ${store.text} > ${department.text} > ${subdepartment.text}: no commodities to iterate.`
          );
          continue;
        }

        const commodityResumeInfo = getResumeStartInfo(
          'commodity',
          commodityOptions.iterate,
          subdepartmentResume
        );

        for (
          let commodityIndex = commodityResumeInfo.startIndex;
          commodityIndex < commodityOptions.iterate.length;
          commodityIndex += 1
        ) {
          throwIfSweepAborted(input);

          const commodityCandidate = commodityOptions.iterate[commodityIndex]!;
          let commodity: SweepOption;

          try {
            commodity = await ensureDropdownSelection(
              input.page,
              input,
              sweepFields.commodity.selector,
              sweepFields.commodity.label,
              commodityCandidate.value,
              sweepFields.commodity.waitForPostback
            );
          } catch (error) {
            throwIfSweepAborted(input, 'Commodity selection aborted');

            if (input.throwOnFreeze && isResumeSelectionError(error)) {
              throwFreshTabResume(
                input,
                createResumeCursor(
                  {
                    store: createResumeCheckpoint(store, storeIndex),
                    department: createResumeCheckpoint(department, departmentIndex),
                    subdepartment: createResumeCheckpoint(subdepartment, subdepartmentIndex),
                    commodity: createResumeCheckpoint(commodityCandidate, commodityIndex),
                  },
                  'commodity',
                  error instanceof Error ? error.message : String(error)
                ),
                { store, department, subdepartment, commodity: commodityCandidate }
              );
            }
            throw error;
          }

          const commodityResume =
            commodityResumeInfo.carryResume && commodityResumeInfo.resumeIndex === commodityIndex
              ? subdepartmentResume
              : null;

          let familyOptions: OptionSet;
          const resolveFamilyOptions = async (): Promise<OptionSet> =>
            resolveOptions(
              input.page,
              sweepFields.family.selector,
              startFromSecondSelections.family,
              input.limits.maxFamilies,
              actionTimeoutMs,
              input.abortSignal
            );

          try {
            familyOptions = await resolveFamilyOptions();
          } catch (error) {
            throwIfSweepAborted(input, 'Family option resolution aborted');

            const familyOptionsMessage = toErrorMessage(error);
            const recoverableFamilyOptionsError =
              isResumeSelectionError(error) ||
              isPageBrokenError(familyOptionsMessage) ||
              isFamilyDropdownTimeoutMessage(familyOptionsMessage);

            if (recoverableFamilyOptionsError) {
              const commodityLabel = `${store.text} > ${department.text} > ${subdepartment.text} > ${commodity.text}`;
              console.warn(
                `${prefix}Family options failed for ${commodity.text}, recovering before retry: ${familyOptionsMessage}`
              );

              const recovered = await recoverPage(
                input.page,
                input.captureOptions.reportUrl,
                prefix,
                input.abortSignal
              );
              const reapplied = recovered
                ? await reapplySelections(
                    input,
                    { store, department, subdepartment, commodity },
                    prefix
                  )
                : false;

              if (recovered && reapplied) {
                try {
                  familyOptions = await resolveFamilyOptions();
                } catch (retryError) {
                  const retryMessage = toErrorMessage(retryError);
                  appendError(
                    input.errorLogPath,
                    `[ghost-family][family-options] ${commodityLabel}: ${retryMessage}`
                  );

                  if (input.throwOnFreeze && isResumeSelectionError(retryError)) {
                    throwFreshTabResume(
                      input,
                      createResumeCursor(
                        {
                          store: createResumeCheckpoint(store, storeIndex),
                          department: createResumeCheckpoint(department, departmentIndex),
                          subdepartment: createResumeCheckpoint(subdepartment, subdepartmentIndex),
                          commodity: createResumeCheckpoint(commodity, commodityIndex),
                        },
                        'family',
                        `Family options unavailable after recovery: ${retryMessage}`
                      ),
                      { store, department, subdepartment, commodity }
                    );
                  }

                  throw retryError;
                }
              } else {
                const recoveryReason = !recovered
                  ? `Family options recovery failed: ${familyOptionsMessage}`
                  : `Family options re-apply failed: ${familyOptionsMessage}`;

                appendError(
                  input.errorLogPath,
                  `[ghost-family][family-options] ${commodityLabel}: ${recoveryReason}`
                );

                if (input.throwOnFreeze) {
                  throwFreshTabResume(
                    input,
                    createResumeCursor(
                      {
                        store: createResumeCheckpoint(store, storeIndex),
                        department: createResumeCheckpoint(department, departmentIndex),
                        subdepartment: createResumeCheckpoint(subdepartment, subdepartmentIndex),
                        commodity: createResumeCheckpoint(commodity, commodityIndex),
                      },
                      'family',
                      recoveryReason
                    ),
                    { store, department, subdepartment, commodity }
                  );
                }

                throw error;
              }
            } else if (input.throwOnFreeze && isResumeSelectionError(error)) {
              throwFreshTabResume(
                input,
                createResumeCursor(
                  {
                    store: createResumeCheckpoint(store, storeIndex),
                    department: createResumeCheckpoint(department, departmentIndex),
                    subdepartment: createResumeCheckpoint(subdepartment, subdepartmentIndex),
                    commodity: createResumeCheckpoint(commodity, commodityIndex),
                  },
                  'family',
                  familyOptionsMessage
                ),
                { store, department, subdepartment, commodity }
              );
            }
            throw error;
          }
          logOptions(sweepFields.family.label, familyOptions, true, prefix);

          if (!familyOptions.iterate.length) {
            console.log(
              `${prefix}Skipping ${store.text} > ${department.text} > ${subdepartment.text} > ${commodity.text}: no families to iterate.`
            );
            continue;
          }

          let consecutiveRecoveries = 0;

          const familyResumeInfo = getResumeStartInfo('family', familyOptions.iterate, commodityResume);

          for (
            let familyIndex = familyResumeInfo.startIndex;
            familyIndex < familyOptions.iterate.length;
            familyIndex += 1
          ) {
            throwIfSweepAborted(input);

            const familyCandidate = familyOptions.iterate[familyIndex]!;
            let family: SweepOption | undefined;

            const familySelectTimeoutMs = readFamilySelectTimeoutMs();

            try {
              family = await withTimeout(
                ensureDropdownSelection(
                  input.page,
                  input,
                  sweepFields.family.selector,
                  sweepFields.family.label,
                  familyCandidate.value,
                  sweepFields.family.waitForPostback
                ),
                familySelectTimeoutMs,
                () => new TimedActionError(`Family selection ${familyCandidate.text}`, familySelectTimeoutMs)
              );
            } catch (familyError) {
              throwIfSweepAborted(input, 'Family selection aborted');

              const familyMsg = toErrorMessage(familyError);
              const isRecoverable = isResumeSelectionError(familyError) || isPageBrokenError(familyMsg);

              if (!isRecoverable) {
                throw familyError;
              }

              // Log the ghost/broken family for later review.
              stats.combinationsVisited += 1;
              stats.combinationsFailed += 1;
              const ghostLabel = `${store.text} > ${department.text} > ${subdepartment.text} > ${commodity.text} > ${familyCandidate.text}`;
              console.warn(`${prefix}Skipping ghost/broken family: ${familyCandidate.text} — ${familyMsg}`);
              appendError(input.errorLogPath, `[ghost-family][family-select] ${ghostLabel}: ${familyMsg}`);

              const resumeAfterFamily = (reason: string): never => {
                throwFreshTabResume(
                  input,
                  createResumeCursor(
                    {
                      store: createResumeCheckpoint(store, storeIndex),
                      department: createResumeCheckpoint(department, departmentIndex),
                      subdepartment: createResumeCheckpoint(subdepartment, subdepartmentIndex),
                      commodity: createResumeCheckpoint(commodity, commodityIndex),
                      family: createResumeCheckpoint(familyCandidate, familyIndex),
                    },
                    'family',
                    reason
                  ),
                  { store, department, subdepartment, commodity, family: familyCandidate }
                );
              };

              if (consecutiveRecoveries >= 3) {
                const reason = `Too many consecutive family recoveries (${consecutiveRecoveries}) while skipping ${familyCandidate.text}: ${familyMsg}`;
                if (input.throwOnFreeze) {
                  resumeAfterFamily(reason);
                }

                console.error(`${prefix}${reason}`);
                break;
              }

              consecutiveRecoveries += 1;
              await sleepWithAbort(1_000, input.abortSignal, 'Family recovery wait aborted');

              const recovered = await recoverPage(
                input.page,
                input.captureOptions.reportUrl,
                prefix,
                input.abortSignal
              );
              if (!recovered) {
                const reason = `Page recovery failed while skipping family ${familyCandidate.text}: ${familyMsg}`;
                if (input.throwOnFreeze) {
                  resumeAfterFamily(reason);
                }

                console.error(`${prefix}Page recovery failed, skipping remaining families for ${commodity.text}.`);
                break;
              }

              const reapplied = await reapplySelections(
                input,
                { store, department, subdepartment, commodity },
                prefix
              );
              if (!reapplied) {
                const reason = `Re-apply failed while skipping family ${familyCandidate.text}: ${familyMsg}`;
                if (input.throwOnFreeze) {
                  resumeAfterFamily(reason);
                }

                console.error(`${prefix}Re-apply failed, skipping remaining families for ${commodity.text}.`);
                break;
              }

              continue;
            }

            if (!family) {
              continue;
            }

            const selection: SweepSelectionContext = {
              store,
              department,
              subdepartment,
              commodity,
              family,
            };

            const combo = selectionLabel(selection);
            stats.combinationsVisited += 1;

            let combinationSucceeded = false;
            let finalErrorMessage = 'Unknown combination failure.';

            for (let combinationAttempt = 1; combinationAttempt <= 2; combinationAttempt += 1) {
              throwIfSweepAborted(input);

              try {
                await ensureExpand(input);

                let replayResult:
                  | {
                      pagesScraped: number[];
                      totalRows: number;
                    }
                  | null = null;

                for (let captureAttempt = 1; captureAttempt <= 2; captureAttempt += 1) {
                  throwIfSweepAborted(input);

                  const beforeCaptureCount = input.getCaptureCount();
                  await clickViewReport(input.page, actionTimeoutMs, input.abortSignal);
                  console.log(`[${combo}] waiting for report render state...`);

                  await waitForReportPageState(
                    input.page,
                    Math.max(10_000, input.captureOptions.renderTimeoutMs),
                    { requireEanHeader: false },
                    actionTimeoutMs,
                    input.abortSignal
                  );

                  const waitMs = Math.max(0, input.captureOptions.postRenderCaptureWaitMs);
                  if (waitMs > 0) {
                    await sleepWithAbort(waitMs, input.abortSignal, `[${combo}] capture wait aborted`);
                  }

                  const preferred = await ensurePreferredCapture(
                    input.page,
                    input.captures,
                    beforeCaptureCount,
                    input.captureOptions,
                    input.getCaptureCount,
                    input.abortSignal
                  );

                  let selectedCapture = preferred.selectedCapture;
                  let selectedSource = preferred.selectedBootstrapSource;

                  if (!selectedCapture) {
                    const fallbackCapture = pickLatestUsableCapture(input.captures, beforeCaptureCount);
                    if (fallbackCapture) {
                      selectedCapture = fallbackCapture;
                      selectedSource = 'network-usable-fallback';
                      console.warn(
                        `[${combo}] preferred payload missing, using fallback eventTarget=${fallbackCapture.eventTarget || 'n/a'}`
                      );
                    }
                  }

                  if (!selectedCapture) {
                    throw new Error('No usable network payload captured for current selection.');
                  }

                  console.log(
                    `[${combo}] payload source: ${selectedSource} (capture attempt ${captureAttempt}/2)`
                  );

                  replayResult = await scrapeFromBootstrap(
                    {
                      requestUrl: selectedCapture.requestUrl,
                      requestHeaders: selectedCapture.requestHeaders,
                      cookieString: selectedCapture.cookieString,
                      bootstrapBody: selectedCapture.bootstrapDataRaw,
                      delayMs: input.requestDelayMs,
                      maxPages: null,
                      abortSignal: input.abortSignal,
                    },
                    {
                      collectRows: false,
                      phasePrefix: 'sweep',
                      logLabel: `[${combo}]`,
                      allowEmptyReport: true,
                      onPageRows: async (rows, pageMeta: ScrapePageInfo) => {
                        const rowsWithSelectionContext = enrichRowsWithSelectionContext(rows, selection);
                        const written = await input.csvAppender.appendRows(
                          rowsWithSelectionContext,
                          selection.store.text
                        );
                        stats.rowsWritten += written;
                        stats.pageRequests += 1;
                        console.log(
                          `[${combo}] page ${pageMeta.currentPage}/${pageMeta.totalPages}: appended ${written} rows`
                        );
                      },
                    }
                  );

                  const suspiciousFallbackEmpty =
                    selectedSource === 'network-usable-fallback' && replayResult.pagesScraped.length === 0;

                  if (suspiciousFallbackEmpty && captureAttempt < 2) {
                    console.warn(
                      `[${combo}] fallback payload produced empty report, retrying View Report once.`
                    );
                    continue;
                  }

                  break;
                }

                if (!replayResult) {
                  throw new Error('Unable to scrape current selection after retries.');
                }

                stats.combinationsScraped += 1;
                console.log(
                  `[${combo}] scraped pages=${replayResult.pagesScraped.length}, rows=${replayResult.totalRows}`
                );

                combinationSucceeded = true;
                break;
              } catch (error) {
                throwIfSweepAborted(input, `[${combo}] combination aborted`);

                const message = error instanceof Error ? error.message : String(error);
                finalErrorMessage = message;

                if (
                  input.throwOnFreeze &&
                  isResumeCombinationError(error) &&
                  !isSkippableFamilyFailure(message)
                ) {
                  stats.combinationsFailed += 1;
                  throwFreshTabResume(
                    input,
                    createResumeCursor(
                      {
                        store: createResumeCheckpoint(store, storeIndex),
                        department: createResumeCheckpoint(department, departmentIndex),
                        subdepartment: createResumeCheckpoint(subdepartment, subdepartmentIndex),
                        commodity: createResumeCheckpoint(commodity, commodityIndex),
                        family: createResumeCheckpoint(family, familyIndex),
                      },
                      'family',
                      message
                    ),
                    selection
                  );
                }

                const shouldRetry = combinationAttempt < 2 && isRetriableSweepError(message);
                if (shouldRetry) {
                  console.warn(
                    `[${combo}] transient failure on attempt ${combinationAttempt}/2: ${message}`
                  );
                  await sleepWithAbort(750, input.abortSignal, `[${combo}] retry wait aborted`);
                  continue;
                }

                break;
              } finally {
                if (input.clearCaptures) {
                  input.clearCaptures();
                }
              }
            }

            if (combinationSucceeded) {
              consecutiveRecoveries = 0;
            } else {
              stats.combinationsFailed += 1;
              const fullMessage = `[${combo}] ${finalErrorMessage}`;
              console.error(`Combination failed: ${fullMessage}`);
              appendError(input.errorLogPath, fullMessage);

              const recoverableFamilyFailure = isSkippableFamilyFailure(finalErrorMessage);

              if (recoverableFamilyFailure) {
                const ghostLabel = `${store.text} > ${department.text} > ${subdepartment.text} > ${commodity.text} > ${family.text}`;
                appendError(
                  input.errorLogPath,
                  `[ghost-family][family-render] ${ghostLabel}: ${finalErrorMessage}`
                );

                const resumeAfterFamily = (reason: string): never => {
                  throwFreshTabResume(
                    input,
                    createResumeCursor(
                      {
                        store: createResumeCheckpoint(store, storeIndex),
                        department: createResumeCheckpoint(department, departmentIndex),
                        subdepartment: createResumeCheckpoint(subdepartment, subdepartmentIndex),
                        commodity: createResumeCheckpoint(commodity, commodityIndex),
                        family: createResumeCheckpoint(family, familyIndex),
                      },
                      'family',
                      reason
                    ),
                    selection
                  );
                };

                if (consecutiveRecoveries >= 3) {
                  const reason = `Too many consecutive family recoveries (${consecutiveRecoveries}) after ${family.text}: ${finalErrorMessage}`;
                  if (input.throwOnFreeze) {
                    resumeAfterFamily(reason);
                  }

                  console.error(`${prefix}${reason}`);
                  break;
                }

                consecutiveRecoveries += 1;
                console.warn(
                  `${prefix}Family render failed, recovering (${consecutiveRecoveries}/3)...`
                );
                await sleepWithAbort(
                  1_000 * consecutiveRecoveries,
                  input.abortSignal,
                  'Family render recovery wait aborted'
                );

                const recovered = await recoverPage(
                  input.page,
                  input.captureOptions.reportUrl,
                  prefix,
                  input.abortSignal
                );
                if (!recovered) {
                  const reason = `Page recovery failed after family ${family.text}: ${finalErrorMessage}`;
                  if (input.throwOnFreeze) {
                    resumeAfterFamily(reason);
                  }

                  console.error(
                    `${prefix}Page recovery failed, skipping remaining families for ${commodity.text}.`
                  );
                  break;
                }

                const reapplied = await reapplySelections(
                  input,
                  { store, department, subdepartment, commodity },
                  prefix
                );

                if (!reapplied) {
                  const reason = `Re-apply failed after family ${family.text}: ${finalErrorMessage}`;
                  if (input.throwOnFreeze) {
                    resumeAfterFamily(reason);
                  }

                  console.error(
                    `${prefix}Re-apply failed after recovery, skipping remaining families for ${commodity.text}.`
                  );
                  break;
                }

                maybeLogSweepTelemetry(prefix, stats, input);
                continue;
              }

              if (input.throwOnFreeze && isResumeCombinationError(finalErrorMessage)) {
                throwFreshTabResume(
                  input,
                  createResumeCursor(
                    {
                      store: createResumeCheckpoint(store, storeIndex),
                      department: createResumeCheckpoint(department, departmentIndex),
                      subdepartment: createResumeCheckpoint(subdepartment, subdepartmentIndex),
                      commodity: createResumeCheckpoint(commodity, commodityIndex),
                      family: createResumeCheckpoint(family, familyIndex),
                    },
                    'family',
                    finalErrorMessage
                  ),
                  selection
                );
              }

            }

            maybeLogSweepTelemetry(prefix, stats, input);
          }
        }
      }
    }
  }

  return stats;
}
