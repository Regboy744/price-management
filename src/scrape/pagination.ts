import { controlFields } from '../../config/ssrs.js';
import type { BootstrapFormParamsResult, FormOverrideChange, ViewStates } from './types.js';

const protectedFields = new Set(['ReportViewerControl$ctl09$VisibilityState$ctl00']);

function dynamicFieldKeys(): Set<string> {
  return new Set([
    controlFields.currentPage,
    controlFields.eventTarget,
    controlFields.viewState,
    controlFields.newViewState,
    controlFields.ajaxScriptManager,
  ]);
}

export function buildBootstrapFormParams(
  rawBootstrapBody: string,
  configuredFormData: Record<string, string>,
  applyFormOverrides = true
): BootstrapFormParamsResult {
  const params = new URLSearchParams(rawBootstrapBody);
  const changedKeys: FormOverrideChange[] = [];
  const skippedKeys: string[] = [];

  if (!applyFormOverrides) {
    return { params, changedKeys, skippedKeys };
  }

  const dynamicKeys = dynamicFieldKeys();

  for (const [key, value] of Object.entries(configuredFormData || {})) {
    if (dynamicKeys.has(key) || protectedFields.has(key)) {
      continue;
    }

    if (!params.has(key)) {
      skippedKeys.push(key);
      continue;
    }

    const nextValue = value === undefined || value === null ? '' : String(value);
    const previousValue = params.get(key) ?? '';

    if (previousValue !== nextValue) {
      changedKeys.push({ key, from: previousValue, to: nextValue });
      params.set(key, nextValue);
    }
  }

  return { params, changedKeys, skippedKeys };
}

export function buildNavigationBody(
  baseFormParams: URLSearchParams,
  states: ViewStates,
  currentPage: number,
  eventTarget: string
): string {
  const params = new URLSearchParams(baseFormParams);

  params.set(controlFields.currentPage, String(currentPage));
  params.set(controlFields.eventTarget, eventTarget);
  params.set(controlFields.viewState, states.viewState);
  params.set(controlFields.newViewState, states.newViewState);
  params.set(controlFields.ajaxScriptManager, `AjaxScriptManager|${eventTarget}`);

  return params.toString();
}
