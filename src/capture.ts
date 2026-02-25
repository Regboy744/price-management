import type { Page } from 'playwright-core';
import type { ExtractedSession } from './types.js';
import { REPORT_VIEWER_PATH } from '../config/report.js';

function deriveReportViewerUrl(pageUrl: string): string {
  try {
    const parsed = new URL(pageUrl);
    const marker = '/Reports/report/';
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex === -1) return '';

    const encodedReportPath = parsed.pathname.slice(markerIndex + marker.length);
    if (!encodedReportPath) return '';

    const reportPath = `/${decodeURIComponent(encodedReportPath)}`;
    const query = `${encodeURIComponent(reportPath)}&rc%3ashowbackbutton=true`;
    return `${parsed.origin}/ReportServer/Pages/ReportViewer.aspx?${query}`;
  } catch {
    return '';
  }
}

export async function extractSessionFromPage(
  page: Page,
  fallbackRequestUrl: string,
  fallbackCookieString: string
): Promise<ExtractedSession> {
  const extracted = await page.evaluate(() => {
    const html = document.documentElement ? document.documentElement.outerHTML : '';
    const form =
      (document.querySelector('form[action*="ReportViewer.aspx"]') as HTMLFormElement | null) ||
      (document.querySelector('form[id*="ReportViewer"]') as HTMLFormElement | null) ||
      (document.querySelector('form') as HTMLFormElement | null);

    const entries: [string, string][] = [];
    let formAction = '';
    let resolvedRequestUrl = window.location.href;

    if (form) {
      formAction = form.getAttribute('action') || '';
      try {
        resolvedRequestUrl = new URL(formAction || window.location.href, window.location.href).href;
      } catch {
        resolvedRequestUrl = window.location.href;
      }

      const fields = form.querySelectorAll('input[name], select[name], textarea[name]');
      fields.forEach((field) => {
        const el = field as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        if (!el.name || el.disabled) return;

        const tag = el.tagName.toLowerCase();

        if (tag === 'input') {
          const input = el as HTMLInputElement;
          const type = (input.getAttribute('type') || 'text').toLowerCase();
          if (['submit', 'button', 'reset', 'file', 'image'].includes(type)) return;
          if ((type === 'checkbox' || type === 'radio') && !input.checked) return;
          entries.push([el.name, el.value || '']);
          return;
        }

        if (tag === 'select') {
          const select = el as HTMLSelectElement;
          if (select.multiple) {
            const selected = Array.from(select.options).filter((o) => o.selected);
            if (selected.length === 0) {
              entries.push([el.name, select.value || '']);
              return;
            }
            selected.forEach((o) => entries.push([el.name, o.value || '']));
            return;
          }
          entries.push([el.name, select.value || '']);
          return;
        }

        if (tag === 'textarea') {
          entries.push([el.name, el.value || '']);
        }
      });
    }

    return {
      html,
      pageUrl: window.location.href,
      title: document.title || '',
      hasForm: Boolean(form),
      formAction,
      requestUrl: resolvedRequestUrl,
      entries,
    };
  });

  const params = new URLSearchParams();
  for (const [key, value] of extracted.entries) {
    params.append(key, value);
  }

  if (!params.has('__EVENTTARGET') || !params.get('__EVENTTARGET')) {
    params.set('__EVENTTARGET', 'ReportViewerControl$ctl09$Reserved_AsyncLoadTarget');
  }

  const eventTarget = params.get('__EVENTTARGET')!;
  params.set('AjaxScriptManager', `AjaxScriptManager|${eventTarget}`);
  params.set('__ASYNCPOST', 'true');

  let requestUrl = extracted.requestUrl || fallbackRequestUrl || extracted.pageUrl;

  if (!requestUrl.includes(REPORT_VIEWER_PATH) && fallbackRequestUrl) {
    requestUrl = fallbackRequestUrl;
  }

  if (!requestUrl.includes(REPORT_VIEWER_PATH)) {
    const derived = deriveReportViewerUrl(extracted.pageUrl);
    if (derived) requestUrl = derived;
  }

  let cookieString = fallbackCookieString || '';
  if (!cookieString) {
    const cookieScopeUrl = requestUrl || extracted.pageUrl;
    const cookies = await page.context().cookies(cookieScopeUrl);
    cookieString = cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
  }

  const initialViewState = params.get('__VIEWSTATE') || '';

  return {
    requestUrl,
    cookieString,
    bootstrapDataRaw: params.toString(),
    initialViewState,
    capturedAt: new Date().toISOString(),
    pageUrl: extracted.pageUrl,
    pageTitle: extracted.title,
    formAction: extracted.formAction,
    html: extracted.html,
    hasForm: extracted.hasForm,
  };
}
