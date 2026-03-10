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
import { sleep } from '../utils.js';
import type { ProductsCsvAppender } from './output.js';
import { scrapeFromBootstrap } from './runner.js';
import type {
  ScrapePageInfo,
  SweepLimits,
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
  captureOptions: CaptureOptions;
  requestDelayMs: number;
  limits: SweepLimits;
  csvAppender: ProductsCsvAppender;
  errorLogPath: string;
  storeCandidates?: SweepOption[];
  logPrefix?: string;
}

interface OptionSet {
  all: SweepOption[];
  iterate: SweepOption[];
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

async function recoverPage(
  page: Page,
  reportUrl: string,
  prefix: string
): Promise<boolean> {
  try {
    console.log(`${prefix}Recovering page after SSRS error (reloading report)...`);
    await page.goto(reportUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    const surface = await waitForReportSurface(page, 45_000);
    if (!surface) {
      console.error(`${prefix}Recovery failed: report surface not detected after reload.`);
      return false;
    }
    console.log(`${prefix}Page recovered, report surface ready.`);
    return true;
  } catch (error) {
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
  maxItems: number | null
): Promise<OptionSet> {
  const enabled = await waitForDropdownEnabled(page, selector, 45_000);
  if (!enabled) {
    throw new Error(`Dropdown stayed disabled: ${selector}`);
  }

  const options = toSweepOptions(await getSelectOptions(page, selector));
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
  const enabled = await waitForDropdownEnabled(page, selector, 45_000);
  if (!enabled) {
    throw new Error(`${label}: dropdown stayed disabled (${selector})`);
  }

  const options = toSweepOptions(await getSelectOptions(page, selector));
  const target = options.find((option) => option.value === targetValue);

  if (!target) {
    const available = options.map((option) => option.value).join(', ');
    throw new Error(`${label}: value ${targetValue} is not available. Found: ${available}`);
  }

  const current = await getSelectedOption(page, selector);
  if (current.value !== targetValue) {
    const beforeCaptureCount = input.getCaptureCount();
    const beforeViewState = await getHiddenFieldValue(page, '#__VIEWSTATE');

    await page.selectOption(selector, targetValue);

    if (waitForPostback) {
      const result = await waitForPostbackOrStateChange(
        page,
        beforeCaptureCount,
        input.getCaptureCount,
        beforeViewState,
        Math.max(1_000, input.captureOptions.selectPostbackTimeoutMs)
      );

      if (result === 'timeout') {
        console.warn(`${label}: no postback/state change detected, continuing.`);
      }
    } else {
      await sleep(150);
    }
  }

  const selected = await getSelectedOption(page, selector);
  if (selected.value !== targetValue) {
    throw new Error(`${label}: selection did not stick (target=${targetValue}, actual=${selected.value || 'none'})`);
  }

  await sleep(Math.max(0, input.captureOptions.selectDelayMs));
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

async function clickViewReport(page: Page): Promise<void> {
  const buttonMatch = await findFirstSelector(page, [VIEW_REPORT_BUTTON_SELECTOR], 20_000);
  if (!buttonMatch) {
    throw new Error('View Report button not found.');
  }

  const enabled = await page
    .$eval(VIEW_REPORT_BUTTON_SELECTOR, (button) => !(button as HTMLButtonElement).disabled)
    .catch(() => false);

  if (!enabled) {
    throw new Error('View Report button is disabled.');
  }

  await buttonMatch.handle.click();
  await sleep(200);
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
  const prefix = input.logPrefix ? `${input.logPrefix} ` : '';

  const stats: SweepStats = {
    storesProcessed: 0,
    combinationsVisited: 0,
    combinationsScraped: 0,
    combinationsFailed: 0,
    rowsWritten: 0,
    pageRequests: 0,
  };

  let storeCandidates: SweepOption[];

  if (input.storeCandidates) {
    storeCandidates = input.storeCandidates;
    console.log(`${prefix}${sweepFields.store.label}: assigned=${storeCandidates.length}`);
  } else {
    const storeOptionSet = await resolveOptions(
      input.page,
      sweepFields.store.selector,
      false,
      input.limits.maxStores
    );
    logOptions(sweepFields.store.label, storeOptionSet, false, prefix);
    storeCandidates = storeOptionSet.iterate;
  }

  for (const storeCandidate of storeCandidates) {
    const store = await ensureDropdownSelection(
      input.page,
      input,
      sweepFields.store.selector,
      sweepFields.store.label,
      storeCandidate.value,
      sweepFields.store.waitForPostback
    );

    stats.storesProcessed += 1;
    console.log(`${prefix}Store selected: ${store.text}`);

    await applyFixedFilters(input);

    const departmentOptions = await resolveOptions(
      input.page,
      sweepFields.department.selector,
      startFromSecondSelections.department,
      input.limits.maxDepartments
    );
    logOptions(sweepFields.department.label, departmentOptions, true, prefix);

    if (!departmentOptions.iterate.length) {
      console.log(`${prefix}Skipping store ${store.text}: no departments to iterate.`);
      continue;
    }

    for (const departmentCandidate of departmentOptions.iterate) {
      const department = await ensureDropdownSelection(
        input.page,
        input,
        sweepFields.department.selector,
        sweepFields.department.label,
        departmentCandidate.value,
        sweepFields.department.waitForPostback
      );

      const subdepartmentOptions = await resolveOptions(
        input.page,
        sweepFields.subdepartment.selector,
        startFromSecondSelections.subdepartment,
        input.limits.maxSubdepartments
      );
      logOptions(sweepFields.subdepartment.label, subdepartmentOptions, true, prefix);

      if (!subdepartmentOptions.iterate.length) {
        console.log(
          `${prefix}Skipping ${store.text} > ${department.text}: no subdepartments to iterate.`
        );
        continue;
      }

      for (const subdepartmentCandidate of subdepartmentOptions.iterate) {
        const subdepartment = await ensureDropdownSelection(
          input.page,
          input,
          sweepFields.subdepartment.selector,
          sweepFields.subdepartment.label,
          subdepartmentCandidate.value,
          sweepFields.subdepartment.waitForPostback
        );

        const commodityOptions = await resolveOptions(
          input.page,
          sweepFields.commodity.selector,
          startFromSecondSelections.commodity,
          input.limits.maxCommodities
        );
        logOptions(sweepFields.commodity.label, commodityOptions, true, prefix);

        if (!commodityOptions.iterate.length) {
          console.log(
            `${prefix}Skipping ${store.text} > ${department.text} > ${subdepartment.text}: no commodities to iterate.`
          );
          continue;
        }

        for (const commodityCandidate of commodityOptions.iterate) {
          const commodity = await ensureDropdownSelection(
            input.page,
            input,
            sweepFields.commodity.selector,
            sweepFields.commodity.label,
            commodityCandidate.value,
            sweepFields.commodity.waitForPostback
          );

          const familyOptions = await resolveOptions(
            input.page,
            sweepFields.family.selector,
            startFromSecondSelections.family,
            input.limits.maxFamilies
          );
          logOptions(sweepFields.family.label, familyOptions, true, prefix);

          if (!familyOptions.iterate.length) {
            console.log(
              `${prefix}Skipping ${store.text} > ${department.text} > ${subdepartment.text} > ${commodity.text}: no families to iterate.`
            );
            continue;
          }

          let consecutiveRecoveries = 0;

          for (const familyCandidate of familyOptions.iterate) {
            let family: SweepOption | undefined;

            try {
              family = await ensureDropdownSelection(
                input.page,
                input,
                sweepFields.family.selector,
                sweepFields.family.label,
                familyCandidate.value,
                sweepFields.family.waitForPostback
              );
            } catch (familyError) {
              const familyMsg = familyError instanceof Error ? familyError.message : String(familyError);

              if (!isPageBrokenError(familyMsg)) {
                throw familyError;
              }

              if (consecutiveRecoveries >= 3) {
                console.error(
                  `${prefix}Too many consecutive page recoveries (${consecutiveRecoveries}), skipping remaining families for ${commodity.text}.`
                );
                break;
              }

              consecutiveRecoveries += 1;
              console.warn(
                `${prefix}Family selection failed (page broken), recovering (${consecutiveRecoveries}/3)...`
              );
              await sleep(1_000 * consecutiveRecoveries);

              const recovered = await recoverPage(input.page, input.captureOptions.reportUrl, prefix);
              if (!recovered) {
                console.error(`${prefix}Page recovery failed, skipping remaining families for ${commodity.text}.`);
                break;
              }

              const reapplied = await reapplySelections(
                input,
                { store, department, subdepartment, commodity },
                prefix
              );
              if (!reapplied) {
                console.error(`${prefix}Re-apply failed, skipping remaining families for ${commodity.text}.`);
                break;
              }

              try {
                family = await ensureDropdownSelection(
                  input.page,
                  input,
                  sweepFields.family.selector,
                  sweepFields.family.label,
                  familyCandidate.value,
                  sweepFields.family.waitForPostback
                );
              } catch (retryError) {
                const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
                stats.combinationsFailed += 1;
                stats.combinationsVisited += 1;
                console.error(`Combination failed: family selection failed after recovery: ${retryMsg}`);
                appendError(input.errorLogPath, `[recovery-retry] family ${familyCandidate.text}: ${retryMsg}`);
                continue;
              }
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
              try {
                await ensureExpand(input);

                let replayResult:
                  | {
                      pagesScraped: number[];
                      totalRows: number;
                    }
                  | null = null;

                for (let captureAttempt = 1; captureAttempt <= 2; captureAttempt += 1) {
                  const beforeCaptureCount = input.getCaptureCount();
                  await clickViewReport(input.page);

                  await waitForReportPageState(
                    input.page,
                    Math.max(10_000, input.captureOptions.renderTimeoutMs),
                    { requireEanHeader: false }
                  );

                  const waitMs = Math.max(0, input.captureOptions.postRenderCaptureWaitMs);
                  if (waitMs > 0) {
                    await sleep(waitMs);
                  }

                  const preferred = await ensurePreferredCapture(
                    input.page,
                    input.captures,
                    beforeCaptureCount,
                    input.captureOptions,
                    input.getCaptureCount
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
                    },
                    {
                      collectRows: false,
                      phasePrefix: 'sweep',
                      logLabel: `[${combo}]`,
                      allowEmptyReport: true,
                      onPageRows: async (rows, pageMeta: ScrapePageInfo) => {
                        const written = await input.csvAppender.appendRows(rows, selection.store.text);
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
                const message = error instanceof Error ? error.message : String(error);
                finalErrorMessage = message;

                const shouldRetry = combinationAttempt < 2 && isRetriableSweepError(message);
                if (shouldRetry) {
                  console.warn(
                    `[${combo}] transient failure on attempt ${combinationAttempt}/2: ${message}`
                  );
                  await sleep(750);
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

              if (isPageBrokenError(finalErrorMessage)) {
                if (consecutiveRecoveries >= 3) {
                  console.error(
                    `${prefix}Too many consecutive page recoveries (${consecutiveRecoveries}), skipping remaining families for ${commodity.text}.`
                  );
                  break;
                }

                consecutiveRecoveries += 1;
                console.warn(
                  `${prefix}Page broken after combination failure, recovering (${consecutiveRecoveries}/3)...`
                );
                await sleep(1_000 * consecutiveRecoveries);

                const recovered = await recoverPage(
                  input.page,
                  input.captureOptions.reportUrl,
                  prefix
                );
                if (recovered) {
                  const reapplied = await reapplySelections(
                    input,
                    { store, department, subdepartment, commodity },
                    prefix
                  );
                  if (!reapplied) {
                    console.error(
                      `${prefix}Re-apply failed after recovery, skipping remaining families for ${commodity.text}.`
                    );
                    break;
                  }
                } else {
                  console.error(
                    `${prefix}Page recovery failed, skipping remaining families for ${commodity.text}.`
                  );
                  break;
                }
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
