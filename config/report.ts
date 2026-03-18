export const DEFAULT_REPORT_URL =
  'https://rsreports-musgravegroup.msappproxy.net/ReportServer/Pages/ReportViewer.aspx?%2fIS+Reports+-+MRPI%2fRetailer+Reports%2fData+-+Price+Management%2fStandard+Article+Report+(R0001)&rc%3ashowbackbutton=true';

export const REPORT_VIEWER_PATH = '/ReportServer/Pages/ReportViewer.aspx';

export const REPORT_CONTENT_MARKERS = {
  title: 'Standard Article Report (R0001)',
} as const;

export const VISIBILITY_STATE_SELECTOR =
  'input[name="ReportViewerControl$ctl09$VisibilityState$ctl00"]';

export const VIEW_REPORT_BUTTON_SELECTOR = '#ReportViewerControl_ctl04_ctl00';
