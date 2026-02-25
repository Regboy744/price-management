export const controlFields = {
  currentPage: 'ReportViewerControl$ctl05$ctl00$CurrentPage',
  eventTarget: '__EVENTTARGET',
  viewState: '__VIEWSTATE',
  newViewState: 'NavigationCorrector$NewViewState',
  ajaxScriptManager: 'AjaxScriptManager',
} as const;

export const eventTargets = {
  next: 'ReportViewerControl$ctl05$ctl00$Next$ctl00',
  previous: 'ReportViewerControl$ctl05$ctl00$Previous$ctl00',
  first: 'ReportViewerControl$ctl05$ctl00$First$ctl00',
  last: 'ReportViewerControl$ctl05$ctl00$Last$ctl00',
} as const;

// Keep overrides empty by default so scrape input stays curl-driven.
export const formData: Record<string, string> = {};

export const pagination = {
  delayBetweenRequests: 1_000,
} as const;
