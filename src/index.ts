import path from 'node:path';
import type { CaptureOptions } from './types.js';
import { envBool } from './utils.js';
import { DEFAULT_REPORT_URL } from '../config/report.js';
import { createLogger } from './config/logger.js';
import { runCaptureWorkflow } from './modules/capture/capture-workflow.js';

function parseArgs(argv: string[]): CaptureOptions {
  const envUsername = process.env['MS_USERNAME'] || process.env['AAD_USERNAME'] || '';
  const envPassword = process.env['MS_PASSWORD'] || process.env['AAD_PASSWORD'] || '';
  const envAutoLogin =
    process.env['AUTO_LOGIN'] !== undefined
      ? envBool(process.env['AUTO_LOGIN'], false)
      : Boolean(envUsername && envPassword);

  const options: CaptureOptions = {
    reportUrl: DEFAULT_REPORT_URL,
    sessionFile: 'outputs/session.ts',
    chromePath: process.env['CHROME_PATH'] || '/usr/bin/google-chrome',
    userDataDir: '.playwright-profile',
    headless: false,
    timeoutMs: 300_000,
    autoLogin: envAutoLogin,
    username: envUsername,
    password: envPassword,
    keepSignedIn: envBool(process.env['MS_KEEP_SIGNED_IN'], false),
    applySelects: !envBool(process.env['SKIP_SELECTS'], false),
    selectDelayMs: Number(process.env['SELECT_DELAY_MS'] || 1_000),
    browserActionTimeoutMs: Number(process.env['BROWSER_ACTION_TIMEOUT_MS'] || 15_000),
    selectPostbackTimeoutMs: Number(process.env['SELECT_POSTBACK_TIMEOUT_MS'] || 6_000),
    freshProfile: true,
    renderTimeoutMs: Number(process.env['REPORT_RENDER_TIMEOUT_MS'] || 180_000),
    postRenderCaptureWaitMs: Number(process.env['POST_RENDER_CAPTURE_WAIT_MS'] || 3_000),
    preferredCaptureTimeoutMs: Number(process.env['PREFERRED_CAPTURE_TIMEOUT_MS'] || 5_000),
    forcedAsyncRetries: Number(process.env['FORCED_ASYNC_RETRIES'] || 2),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];

    switch (arg) {
      case '--url':
        if (next) { options.reportUrl = next; i++; }
        break;
      case '--session-file':
        if (next) { options.sessionFile = next; i++; }
        break;
      case '--chrome-path':
        if (next) { options.chromePath = next; i++; }
        break;
      case '--user-data-dir':
        if (next) { options.userDataDir = next; i++; }
        break;
      case '--fresh-profile':
        options.freshProfile = true;
        break;
      case '--timeout-ms':
        if (next) { options.timeoutMs = Number(next); i++; }
        break;
      case '--select-delay-ms':
        if (next) { options.selectDelayMs = Number(next); i++; }
        break;
      case '--browser-action-timeout-ms':
        if (next) { options.browserActionTimeoutMs = Number(next); i++; }
        break;
      case '--select-postback-timeout-ms':
        if (next) { options.selectPostbackTimeoutMs = Number(next); i++; }
        break;
      case '--render-timeout-ms':
        if (next) { options.renderTimeoutMs = Number(next); i++; }
        break;
      case '--post-render-capture-wait-ms':
        if (next) { options.postRenderCaptureWaitMs = Number(next); i++; }
        break;
      case '--preferred-capture-timeout-ms':
        if (next) { options.preferredCaptureTimeoutMs = Number(next); i++; }
        break;
      case '--forced-async-retries':
        if (next) { options.forcedAsyncRetries = Number(next); i++; }
        break;
      case '--headless':
        options.headless = true;
        break;
      case '--auto-login':
        options.autoLogin = true;
        break;
      case '--manual-login':
        options.autoLogin = false;
        break;
      case '--username':
        if (next) { options.username = next; i++; }
        break;
      case '--password':
        if (next) { options.password = next; i++; }
        break;
      case '--keep-signed-in':
        console.warn('--keep-signed-in is ignored. capture forces no keep-signed-in.');
        break;
      case '--no-keep-signed-in':
        options.keepSignedIn = false;
        break;
      case '--skip-selects':
        options.applySelects = false;
        break;
      case '--apply-selects':
        options.applySelects = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
    }
  }

  options.freshProfile = true;
  options.keepSignedIn = false;
  return options;
}

function printUsage(): void {
  console.log('Usage: pnpm capture [options]');
  console.log('');
  console.log('Options:');
  console.log('  --url <report-url>                      Report page URL to open');
  console.log('  --session-file <path>                   Session output file');
  console.log('  --chrome-path <path>                    Chrome executable path');
  console.log('  --user-data-dir <path>                  Persistent browser profile directory');
  console.log('  --fresh-profile                         Delete profile before run');
  console.log('  --timeout-ms <ms>                       Headless wait timeout');
  console.log('  --select-delay-ms <ms>                  Delay after each dropdown selection');
  console.log('  --browser-action-timeout-ms <ms>        Hard timeout for page actions');
  console.log('  --select-postback-timeout-ms <ms>       Wait for dropdown postback');
  console.log('  --render-timeout-ms <ms>                Wait after View Report click');
  console.log('  --post-render-capture-wait-ms <ms>      Extra wait for final network payload');
  console.log('  --preferred-capture-timeout-ms <ms>     Wait for preferred ctl09 capture');
  console.log('  --forced-async-retries <n>              Force ctl09 postback retry count');
  console.log('  --headless                              Run without visible browser');
  console.log('  --auto-login                            Use credentials from .env');
  console.log('  --manual-login                          Disable auto login');
  console.log('  --username <value>                      Login username/email');
  console.log('  --password <value>                      Login password');
  console.log('  --keep-signed-in                        Ignored (fresh mode forces No)');
  console.log('  --no-keep-signed-in                     Keep signed in = No (default)');
  console.log('  --skip-selects                          Skip dropdown workflow');
  console.log('  --apply-selects                         Run dropdown workflow');
  console.log('  --help                                  Show this help');
  console.log('');
  console.log('Env vars: MS_USERNAME, MS_PASSWORD, MS_KEEP_SIGNED_IN, AUTO_LOGIN,');
  console.log('  CHROME_PATH, SELECT_DELAY_MS, BROWSER_ACTION_TIMEOUT_MS, SELECT_POSTBACK_TIMEOUT_MS,');
  console.log('  REPORT_RENDER_TIMEOUT_MS, POST_RENDER_CAPTURE_WAIT_MS,');
  console.log('  PREFERRED_CAPTURE_TIMEOUT_MS, FORCED_ASYNC_RETRIES, SKIP_SELECTS,');
  console.log('  CAPTURE_MAX_ITEMS, CAPTURE_MAX_BYTES_MB');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  const outputDir = path.resolve('outputs');
  const logger = createLogger({ mode: 'cli-capture' });

  console.log('Auto login:', options.autoLogin ? 'enabled' : 'disabled');
  console.log('Dropdown workflow:', options.applySelects ? 'enabled' : 'skipped');
  console.log('Fresh profile: forced on (always starts clean)');
  console.log('Keep signed in: forced off for fresh sessions');
  console.log('Mode: payload capture for one validated selection. Use scrape:all for the full dataset.');

  if (!options.autoLogin && !options.headless) {
    console.log('Capture CLI now expects an authenticated browser profile when auto login is disabled.');
    console.log('If you need manual login, first sign in with a reusable profile and re-run with --manual-login --user-data-dir <path>.');
  }

  const result = await runCaptureWorkflow({
    options,
    logger,
    paths: {
      selectedCurlPath: path.join(outputDir, 'selected-report-request.curl.sh'),
      payloadDirPath: path.join(outputDir, 'payloads'),
      payloadIndexPath: path.join(outputDir, 'payload-index.json'),
      curlDirPath: path.join(outputDir, 'captured-curls'),
      curlBundlePath: path.join(outputDir, 'captured-requests.curl.sh'),
      summaryPath: path.join(outputDir, 'capture-summary.json'),
      failureScreenshotPath: path.join(outputDir, 'capture-failure.png'),
      failureHtmlPath: path.join(outputDir, 'capture-failure.html'),
    },
  });

  console.log('Selected bootstrap source:', result.selectedBootstrapSource);
  console.log('Selected curl written to:', result.selectedCurlPath);
  if (result.selection) {
    console.log(
      'Chosen filters:',
      `${result.selection.store.text} > ${result.selection.department.text} > ${result.selection.subdepartment.text} > ${result.selection.commodity.text} > ${result.selection.family.text}`
    );
  }
  console.log('Done.');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Capture failed:', message);
  process.exit(1);
});
