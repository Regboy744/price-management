import type { Page } from 'playwright-core';
import { fixedSelections, startFromSecondSelections, sweepFields } from '../../../config/sweep.js';
import { VIEW_REPORT_BUTTON_SELECTOR } from '../../../config/report.js';
import type { Logger } from '../../config/logger.js';
import {
  findFirstSelector,
  getHiddenFieldValue,
  getSelectOptions,
  getSelectedOption,
  waitForDropdownEnabled,
  waitForPostbackOrStateChange,
} from '../../dom.js';
import { waitForReportPageState } from '../../report.js';
import type { SweepOption } from '../../scrape/types.js';
import type { CaptureOptions, DropdownWorkflowResult, SelectOption } from '../../types.js';
import { sleep } from '../../utils.js';

export interface CaptureSelectionContext {
  page: Page;
  options: CaptureOptions;
  getCaptureCount: () => number;
  logger: Logger;
}

export interface CaptureSelectionResult extends DropdownWorkflowResult {
  selection: {
    store: SweepOption;
    department: SweepOption;
    subdepartment: SweepOption;
    commodity: SweepOption;
    family: SweepOption;
  };
}

function toSweepOptions(options: SelectOption[]): SweepOption[] {
  return options
    .filter((option) => option.value.trim().length > 0)
    .map((option) => ({
      value: option.value,
      text: option.text,
    }));
}

function choosePreferredOption(options: SweepOption[], startFromSecond: boolean): SweepOption {
  const iterateCandidates = options.slice(startFromSecond ? 1 : 0);
  return iterateCandidates[0] || options[0]!;
}

async function ensureDropdownSelection(
  page: Page,
  context: CaptureSelectionContext,
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
  context.logger.info('Evaluating dropdown selection', {
    label,
    selector,
    currentValue: current.value || null,
    currentText: current.text || null,
    targetValue,
    targetText: target.text,
    optionCount: options.length,
  });

  if (current.value !== targetValue) {
    const beforeCaptureCount = context.getCaptureCount();
    const beforeViewState = await getHiddenFieldValue(page, '#__VIEWSTATE');

    await page.selectOption(selector, targetValue);

    if (waitForPostback) {
      const result = await waitForPostbackOrStateChange(
        page,
        beforeCaptureCount,
        context.getCaptureCount,
        beforeViewState,
        Math.max(1_000, context.options.selectPostbackTimeoutMs)
      );

      if (result === 'timeout') {
        context.logger.warn('Dropdown selection timed out waiting for postback', {
          label,
          selector,
          targetValue,
          timeoutMs: context.options.selectPostbackTimeoutMs,
        });
      }
    } else {
      await sleep(150);
    }
  }

  const selected = await getSelectedOption(page, selector);
  if (selected.value !== targetValue) {
    throw new Error(
      `${label}: selection did not stick (target=${targetValue}, actual=${selected.value || 'none'})`
    );
  }

  await sleep(Math.max(0, context.options.selectDelayMs));
  return {
    value: selected.value,
    text: selected.text || target.text,
  };
}

async function chooseAndSelectOption(
  page: Page,
  context: CaptureSelectionContext,
  selector: string,
  label: string,
  startFromSecond: boolean,
  waitForPostback: boolean
): Promise<SweepOption> {
  const enabled = await waitForDropdownEnabled(page, selector, 45_000);
  if (!enabled) {
    throw new Error(`${label}: dropdown stayed disabled (${selector})`);
  }

  const options = toSweepOptions(await getSelectOptions(page, selector));
  if (!options.length) {
    throw new Error(`${label}: dropdown has no selectable options.`);
  }

  const chosen = choosePreferredOption(options, startFromSecond);
  return ensureDropdownSelection(page, context, selector, label, chosen.value, waitForPostback);
}

async function applyFixedFilters(context: CaptureSelectionContext): Promise<void> {
  await ensureDropdownSelection(
    context.page,
    context,
    sweepFields.saleable.selector,
    sweepFields.saleable.label,
    fixedSelections.saleable,
    sweepFields.saleable.waitForPostback
  );
  await ensureDropdownSelection(
    context.page,
    context,
    sweepFields.orderable.selector,
    sweepFields.orderable.label,
    fixedSelections.orderable,
    sweepFields.orderable.waitForPostback
  );
  await ensureDropdownSelection(
    context.page,
    context,
    sweepFields.mainSupplierOnly.selector,
    sweepFields.mainSupplierOnly.label,
    fixedSelections.mainSupplierOnly,
    sweepFields.mainSupplierOnly.waitForPostback
  );
  await ensureDropdownSelection(
    context.page,
    context,
    sweepFields.suppliers.selector,
    sweepFields.suppliers.label,
    fixedSelections.suppliers,
    sweepFields.suppliers.waitForPostback
  );
}

async function ensureExpand(context: CaptureSelectionContext): Promise<void> {
  await ensureDropdownSelection(
    context.page,
    context,
    sweepFields.expand.selector,
    sweepFields.expand.label,
    fixedSelections.expand,
    sweepFields.expand.waitForPostback
  );
}

async function clickViewReport(context: CaptureSelectionContext): Promise<void> {
  const buttonMatch = await findFirstSelector(context.page, [VIEW_REPORT_BUTTON_SELECTOR], 20_000);
  if (!buttonMatch) {
    throw new Error('View Report button not found.');
  }

  const enabled = await context.page
    .$eval(VIEW_REPORT_BUTTON_SELECTOR, (button) => !(button as HTMLButtonElement).disabled)
    .catch(() => false);

  if (!enabled) {
    throw new Error('View Report button is disabled.');
  }

  context.logger.info('Clicking View Report button');
  await buttonMatch.handle.click();
  await sleep(200);
}

export async function applyInitialCaptureSelections(
  context: CaptureSelectionContext
): Promise<CaptureSelectionResult> {
  context.logger.info('Applying dynamic capture selections');

  const store = await chooseAndSelectOption(
    context.page,
    context,
    sweepFields.store.selector,
    sweepFields.store.label,
    false,
    sweepFields.store.waitForPostback
  );

  await applyFixedFilters(context);

  const department = await chooseAndSelectOption(
    context.page,
    context,
    sweepFields.department.selector,
    sweepFields.department.label,
    startFromSecondSelections.department,
    sweepFields.department.waitForPostback
  );

  const subdepartment = await chooseAndSelectOption(
    context.page,
    context,
    sweepFields.subdepartment.selector,
    sweepFields.subdepartment.label,
    startFromSecondSelections.subdepartment,
    sweepFields.subdepartment.waitForPostback
  );

  const commodity = await chooseAndSelectOption(
    context.page,
    context,
    sweepFields.commodity.selector,
    sweepFields.commodity.label,
    startFromSecondSelections.commodity,
    sweepFields.commodity.waitForPostback
  );

  const family = await chooseAndSelectOption(
    context.page,
    context,
    sweepFields.family.selector,
    sweepFields.family.label,
    startFromSecondSelections.family,
    sweepFields.family.waitForPostback
  );

  await ensureExpand(context);

  const beforeViewReportCaptureCount = context.getCaptureCount();
  await clickViewReport(context);

  const reportState = await waitForReportPageState(context.page, Math.max(60_000, context.options.renderTimeoutMs));
  const captureCountAtRenderComplete = context.getCaptureCount();
  const renderCompletedAt = new Date().toISOString();

  const postRenderCaptureWaitMs = Math.max(0, context.options.postRenderCaptureWaitMs);
  if (postRenderCaptureWaitMs > 0) {
    context.logger.info('Waiting for post-render network capture window', {
      waitMs: postRenderCaptureWaitMs,
    });
    await sleep(postRenderCaptureWaitMs);
  }

  const captureCountAfterPostRenderWait = context.getCaptureCount();

  context.logger.info('Dynamic capture selection completed', {
    selection: {
      store: store.text,
      department: department.text,
      subdepartment: subdepartment.text,
      commodity: commodity.text,
      family: family.text,
    },
    visibilityState: reportState.visibilityState,
    hasReportTitle: reportState.hasReportTitle,
    hasEanHeader: reportState.hasEanHeader,
  });

  return {
    selection: {
      store,
      department,
      subdepartment,
      commodity,
      family,
    },
    beforeViewReportCaptureCount,
    captureCountAtRenderComplete,
    captureCountAfterPostRenderWait,
    renderCompletedAt,
    reportState,
  };
}
