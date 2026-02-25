import type { Page } from 'playwright-core';
import type { CaptureOptions, DropdownStep, DropdownWorkflowResult } from './types.js';
import { sleep } from './utils.js';
import { VIEW_REPORT_BUTTON_SELECTOR } from '../config/report.js';
import {
  findFirstSelector,
  getHiddenFieldValue,
  getSelectOptions,
  getSelectedOption,
  waitForDropdownEnabled,
  waitForPostbackOrStateChange,
} from './dom.js';
import { waitForReportPageState } from './report.js';

export async function applyDropdownSelections(
  page: Page,
  steps: DropdownStep[],
  options: CaptureOptions,
  getCaptureCount: () => number
): Promise<DropdownWorkflowResult> {
  const selectDelayMs = Math.max(0, options.selectDelayMs);
  const selectPostbackTimeoutMs = Math.max(1_000, options.selectPostbackTimeoutMs);
  const renderTimeoutMs = Math.max(60_000, options.renderTimeoutMs);

  console.log('Applying dropdown selections...');

  for (const step of steps) {
    if (!step.value) {
      console.log(`Skipping ${step.label}: no value configured for ${step.key}`);
      continue;
    }

    const exists = await findFirstSelector(page, [step.selector], 30_000);
    if (!exists) {
      throw new Error(`Dropdown not found for ${step.label}: ${step.selector}`);
    }

    const ready = await waitForDropdownEnabled(page, step.selector, 45_000);
    if (!ready) {
      throw new Error(`Dropdown stayed disabled for ${step.label}: ${step.selector}`);
    }

    const optionsList = await getSelectOptions(page, step.selector);
    if (optionsList.length === 0) {
      throw new Error(`Dropdown has no options for ${step.label}: ${step.selector}`);
    }

    const hasTarget = optionsList.some((opt) => opt.value === step.value);
    if (!hasTarget) {
      const available = optionsList.map((opt) => opt.value).join(', ');
      throw new Error(`${step.label}: value ${step.value} not found. Available: ${available}`);
    }

    const currentSelection = await getSelectedOption(page, step.selector);
    console.log(
      `${step.label}: target=${step.value}, current=${currentSelection.value || 'none'} (${currentSelection.text || 'n/a'}), options=${optionsList.length}`
    );

    if (currentSelection.value !== step.value) {
      const beforeCaptureCount = getCaptureCount();
      const beforeViewState = await getHiddenFieldValue(page, '#__VIEWSTATE');

      await page.selectOption(step.selector, step.value);

      if (step.waitForPostback) {
        const result = await waitForPostbackOrStateChange(
          page,
          beforeCaptureCount,
          getCaptureCount,
          beforeViewState,
          selectPostbackTimeoutMs
        );

        if (result === 'timeout') {
          console.warn(
            `${step.label}: no postback/state change detected in ${selectPostbackTimeoutMs}ms, continuing.`
          );
        }
      } else {
        await sleep(150);
      }

      const afterSelection = await getSelectedOption(page, step.selector);
      if (afterSelection.value !== step.value) {
        throw new Error(
          `${step.label}: selection did not stick. Target=${step.value}, actual=${afterSelection.value || 'none'}`
        );
      }

      console.log(`${step.label}: selected ${afterSelection.value} (${afterSelection.text || 'n/a'})`);
    } else {
      console.log(`${step.label}: already selected, no postback needed.`);
    }

    await sleep(selectDelayMs);
  }

  // Click View Report
  const viewReportButton = await findFirstSelector(page, [VIEW_REPORT_BUTTON_SELECTOR], 20_000);
  if (!viewReportButton) {
    throw new Error('View Report button not found.');
  }

  const viewReportEnabled = await page
    .$eval(VIEW_REPORT_BUTTON_SELECTOR, (btn) => !(btn as HTMLButtonElement).disabled)
    .catch(() => false);

  if (!viewReportEnabled) {
    throw new Error('View Report button is disabled.');
  }

  console.log('Clicking View Report...');

  const beforeViewReportCaptureCount = getCaptureCount();
  await viewReportButton.handle.click();
  await sleep(200);

  const reportState = await waitForReportPageState(page, renderTimeoutMs);
  const captureCountAtRenderComplete = getCaptureCount();
  const renderCompletedAt = new Date().toISOString();

  console.log(
    `Report content loaded with visibility state=${reportState.visibilityState || 'unknown'} (title=${reportState.hasReportTitle}, ean=${reportState.hasEanHeader})`
  );

  const postRenderCaptureWaitMs = Math.max(0, options.postRenderCaptureWaitMs);
  if (postRenderCaptureWaitMs > 0) {
    console.log(`Waiting ${postRenderCaptureWaitMs}ms for final post-render payload capture...`);
    await sleep(postRenderCaptureWaitMs);
  }

  const captureCountAfterPostRenderWait = getCaptureCount();

  return {
    beforeViewReportCaptureCount,
    captureCountAtRenderComplete,
    captureCountAfterPostRenderWait,
    renderCompletedAt,
    reportState,
  };
}
