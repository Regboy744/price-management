import type { Page, ElementHandle } from 'playwright-core';
import type { SelectorMatch, SelectedOption, SelectOption } from './types.js';
import {
  sleep,
  sleepWithAbort,
  throwIfAborted,
  TimedActionError,
  withTimeout,
} from './utils.js';

export async function findFirstSelector(
  page: Page,
  selectors: string[],
  timeoutMs: number,
  actionTimeoutMs = 0,
  abortSignal?: AbortSignal
): Promise<SelectorMatch | null> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    throwIfAborted(abortSignal, 'Selector search aborted');

    try {
      for (const selector of selectors) {
        const handle = await withTimeout(
          page.$(selector),
          actionTimeoutMs,
          () => new TimedActionError(`Find selector ${selector}`, actionTimeoutMs)
        );
        if (handle) {
          return { selector, handle };
        }
      }
    } catch (error) {
      if (error instanceof TimedActionError) {
        throw error;
      }
      // Frame may be detached during navigation (e.g. Entra redirect) — retry
    }
    await sleepWithAbort(250, abortSignal, 'Selector search aborted');
  }

  return null;
}

export async function typeIntoField(page: Page, selector: string, value: string): Promise<string> {
  const handle = await page.waitForSelector(selector, { state: 'visible', timeout: 10_000 }).catch(() => null);
  if (!handle) {
    return '';
  }

  try {
    await handle.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(selector, value, { delay: 35 });
  } catch {
    return '';
  }

  let finalValue = await page
    .$eval(selector, (el) => (el as HTMLInputElement).value || '')
    .catch(() => '');

  if (finalValue !== value) {
    await page
      .$eval(
        selector,
        (el, nextValue) => {
          const input = el as HTMLInputElement;
          input.value = String(nextValue || '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
        value
      )
      .catch(() => null);

    finalValue = await page
      .$eval(selector, (el) => (el as HTMLInputElement).value || '')
      .catch(() => '');
  }

  return finalValue;
}

export async function clickAndSettle(
  page: Page,
  handle: ElementHandle
): Promise<void> {
  const navigation = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 })
    .catch(() => null);

  await handle.click();
  await navigation;
  await sleep(400);
}

export async function maybeClickSelector(
  page: Page,
  selectors: string[],
  timeoutMs: number
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const remainingMs = Math.max(250, timeoutMs - (Date.now() - start));
    const found = await findFirstSelector(page, selectors, Math.min(1_000, remainingMs));
    if (!found) {
      await sleep(150);
      continue;
    }

    try {
      await clickAndSettle(page, found.handle);
      return true;
    } catch {
      // Element may go stale between find and click during auth redirects; retry.
    }

    await sleep(150);
  }

  return false;
}

export async function getHiddenFieldValue(
  page: Page,
  selector: string,
  actionTimeoutMs = 0
): Promise<string> {
  try {
    return await withTimeout(
      page.$eval(selector, (el) => (el as HTMLInputElement).value || ''),
      actionTimeoutMs,
      () => new TimedActionError(`Read hidden field ${selector}`, actionTimeoutMs)
    );
  } catch (error) {
    if (error instanceof TimedActionError) {
      throw error;
    }
    return '';
  }
}

export async function waitForDropdownEnabled(
  page: Page,
  selector: string,
  timeoutMs: number,
  actionTimeoutMs = 0,
  abortSignal?: AbortSignal
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    throwIfAborted(abortSignal, `Dropdown wait aborted: ${selector}`);

    const state = await withTimeout(
      page.$eval(selector, (el) => {
        const select = el as HTMLSelectElement;
        return {
          exists: true,
          disabled: select.disabled,
          optionCount: select.options ? select.options.length : 0,
        };
      }),
      actionTimeoutMs,
      () => new TimedActionError(`Read dropdown state ${selector}`, actionTimeoutMs)
    ).catch((error) => {
      if (error instanceof TimedActionError) {
        throw error;
      }
      return { exists: false, disabled: true, optionCount: 0 };
    });

    if (state.exists && !state.disabled && state.optionCount > 0) {
      return true;
    }

    await sleepWithAbort(250, abortSignal, `Dropdown wait aborted: ${selector}`);
  }

  return false;
}

export async function getSelectOptions(
  page: Page,
  selector: string,
  actionTimeoutMs = 0
): Promise<SelectOption[]> {
  try {
    return await withTimeout(
      page.$$eval(`${selector} option`, (options) =>
      options.map((opt) => ({
        value: (opt as HTMLOptionElement).value,
        text: (opt.textContent || '').replace(/\s+/g, ' ').trim(),
        selected: (opt as HTMLOptionElement).selected,
      }))
      ),
      actionTimeoutMs,
      () => new TimedActionError(`Read options ${selector}`, actionTimeoutMs)
    );
  } catch (error) {
    if (error instanceof TimedActionError) {
      throw error;
    }
    return [];
  }
}

export async function getSelectedOption(
  page: Page,
  selector: string,
  actionTimeoutMs = 0
): Promise<SelectedOption> {
  try {
    return await withTimeout(
      page.$eval(selector, (el) => {
        const select = el as HTMLSelectElement;
        if (!select || select.selectedIndex < 0) {
          return { value: '', text: '' };
        }

        const selected = select.options[select.selectedIndex];
        return {
          value: selected ? selected.value || '' : select.value || '',
          text: selected ? (selected.textContent || '').replace(/\s+/g, ' ').trim() : '',
        };
      }),
      actionTimeoutMs,
      () => new TimedActionError(`Read selected option ${selector}`, actionTimeoutMs)
    );
  } catch (error) {
    if (error instanceof TimedActionError) {
      throw error;
    }
    return { value: '', text: '' };
  }
}

export async function waitForPostbackOrStateChange(
  page: Page,
  beforeCaptureCount: number,
  getCaptureCount: () => number,
  beforeViewState: string,
  timeoutMs: number,
  actionTimeoutMs = 0,
  abortSignal?: AbortSignal
): Promise<string> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    throwIfAborted(abortSignal, 'Postback wait aborted');

    if (getCaptureCount() > beforeCaptureCount) {
      return 'network';
    }

    const currentViewState = await getHiddenFieldValue(page, '#__VIEWSTATE', actionTimeoutMs);
    if (beforeViewState && currentViewState && currentViewState !== beforeViewState) {
      return 'viewstate';
    }

    await sleepWithAbort(250, abortSignal, 'Postback wait aborted');
  }

  return 'timeout';
}
