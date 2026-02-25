import fs from 'node:fs';
import path from 'node:path';
import type { NetworkCapture, PayloadRecord, SessionOutput } from './types.js';
import { isPreferredScrapeBootstrapBody } from './report.js';
import { sanitizeToken, shellSingleQuote } from './utils.js';

export function toSessionFileContent(session: SessionOutput): string {
  return [
    `export const cookieString = ${JSON.stringify(session.cookieString)};`,
    `export const requestUrl = ${JSON.stringify(session.requestUrl)};`,
    `export const bootstrapDataRaw = ${JSON.stringify(session.bootstrapDataRaw)};`,
    `export const initialViewState = ${JSON.stringify(session.initialViewState)};`,
    '',
  ].join('\n');
}

function normalizeHeadersForCurl(headers: Record<string, string>): [string, string][] {
  return Object.entries(headers || {})
    .filter(([name, value]) => Boolean(name) && value !== undefined && value !== null)
    .filter(([, value]) => String(value).length > 0)
    .filter(([name]) => !name.startsWith(':'))
    .filter(([name]) => {
      const lower = name.toLowerCase();
      return lower !== 'cookie' && lower !== 'content-length';
    })
    .map(([name, value]) => [String(name), String(value)]);
}

export function buildCurlCommand(capture: NetworkCapture): string {
  const requestUrl = capture.requestUrl || '';
  const body = capture.bootstrapDataRaw || '';
  const cookieString = capture.cookieString || '';
  const headerEntries = normalizeHeadersForCurl(capture.requestHeaders);

  const lines = [`curl ${shellSingleQuote(requestUrl)} \\`];

  for (const [name, value] of headerEntries) {
    lines.push(`  -H ${shellSingleQuote(`${name}: ${value}`)} \\`);
  }

  if (cookieString) {
    lines.push(`  -b ${shellSingleQuote(cookieString)} \\`);
  }

  lines.push(`  --data-raw ${shellSingleQuote(body)}`);
  return lines.join('\n');
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function writeSessionFile(filePath: string, session: SessionOutput): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, toSessionFileContent(session), 'utf8');
}

export function writeJson(filePath: string, data: unknown): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export function writeText(filePath: string, content: string): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, content, 'utf8');
}

export function savePostRenderPayloads(
  captures: NetworkCapture[],
  payloadDirPath: string,
  payloadIndexPath: string,
  curlDirPath: string,
  curlBundlePath: string
): PayloadRecord[] {
  fs.rmSync(payloadDirPath, { recursive: true, force: true });
  fs.rmSync(curlDirPath, { recursive: true, force: true });

  fs.mkdirSync(payloadDirPath, { recursive: true });
  fs.mkdirSync(curlDirPath, { recursive: true });

  const records: PayloadRecord[] = [];
  const curlBundleParts: string[] = [];

  for (const capture of captures) {
    const body = capture.bootstrapDataRaw || '';
    const params = new URLSearchParams(body);
    const eventTarget = params.get('__EVENTTARGET') || '';
    const ajaxScriptManager = params.get('AjaxScriptManager') || '';
    const hasViewState = Boolean(params.get('__VIEWSTATE'));
    const hasNewViewState = Boolean(params.get('NavigationCorrector$NewViewState'));
    const preferred = isPreferredScrapeBootstrapBody(body);

    const prefix = String(capture.sequence).padStart(3, '0');
    const slug = sanitizeToken(eventTarget || 'no-event-target');

    const payloadFileName = `${prefix}-${slug}.payload.txt`;
    const payloadFilePath = path.join(payloadDirPath, payloadFileName);
    fs.writeFileSync(payloadFilePath, `${body}\n`, 'utf8');

    const curlFileName = `${prefix}-${slug}.curl.sh`;
    const curlFilePath = path.join(curlDirPath, curlFileName);
    const curlCommand = buildCurlCommand(capture);
    fs.writeFileSync(curlFilePath, `${curlCommand}\n`, 'utf8');

    curlBundleParts.push(
      `# sequence=${capture.sequence} eventTarget=${eventTarget || '(empty)'} preferred=${preferred}`
    );
    curlBundleParts.push(curlCommand);
    curlBundleParts.push('');

    records.push({
      sequence: capture.sequence,
      capturedAt: capture.capturedAt,
      requestUrl: capture.requestUrl,
      eventTarget,
      ajaxScriptManager,
      currentPage: capture.currentPage,
      bodyLength: body.length,
      hasViewState,
      hasNewViewState,
      preferred,
      payloadFile: path.relative(process.cwd(), payloadFilePath),
      curlFile: path.relative(process.cwd(), curlFilePath),
    });
  }

  ensureDir(payloadIndexPath);
  fs.writeFileSync(payloadIndexPath, JSON.stringify(records, null, 2), 'utf8');

  ensureDir(curlBundlePath);
  fs.writeFileSync(curlBundlePath, `${curlBundleParts.join('\n')}\n`, 'utf8');

  return records;
}
