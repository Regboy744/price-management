import path from 'node:path';
import readline from 'node:readline';
import type { CaptureOptions } from './types.js';
import { envBool } from './utils.js';
import { DEFAULT_REPORT_URL } from '../config/report.js';
import dropdownSteps from '../config/dropdowns.js';
import { launchBrowser, attachNetworkCapture } from './browser.js';
import { runAutomatedLogin } from './auth.js';
import { waitForReportSurface, ensurePreferredCapture } from './report.js';
import { applyDropdownSelections } from './dropdowns.js';
import { writeText, buildCurlCommand } from './output.js';

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
  console.log('  CHROME_PATH, SELECT_DELAY_MS, SELECT_POSTBACK_TIMEOUT_MS,');
  console.log('  REPORT_RENDER_TIMEOUT_MS, POST_RENDER_CAPTURE_WAIT_MS,');
  console.log('  PREFERRED_CAPTURE_TIMEOUT_MS, FORCED_ASYNC_RETRIES, SKIP_SELECTS,');
  console.log('  CAPTURE_MAX_ITEMS, CAPTURE_MAX_BYTES_MB');
}

function waitForEnter(promptText: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${promptText}\n`, () => {
      rl.close();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  const outputDir = path.resolve('outputs');
  const selectedCurlPath = path.join(outputDir, 'selected-report-request.curl.sh');

  console.log('Auto login:', options.autoLogin ? 'enabled' : 'disabled');
  console.log('Dropdown workflow:', options.applySelects ? 'enabled' : 'skipped');
  console.log('Fresh profile: forced on (always starts clean)');
  console.log('Keep signed in: forced off for fresh sessions');

  const browser = await launchBrowser(options);
  let captureContext: ReturnType<typeof attachNetworkCapture> | null = null;

  try {
    const page = await browser.newPage();
    await page.bringToFront().catch(() => null);
    captureContext = attachNetworkCapture(page);
    const { captures, getCaptureCount } = captureContext;

    console.log('Opening report URL...');
    await page.goto(options.reportUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });

    // Authentication
    if (options.autoLogin) {
      await runAutomatedLogin(page, options);
    } else if (!options.headless) {
      console.log('Complete login/MFA in the browser, then open the report until it loads.');
      await waitForEnter('Press Enter after the report page is visible.');
    } else {
      throw new Error('Headless mode requires --auto-login or a pre-authenticated profile.');
    }

    // Wait for report surface
    const reportSurface = await waitForReportSurface(page, options.timeoutMs);
    if (!reportSurface) {
      throw new Error(
        'Could not detect report surface after login. Make sure the report page is loaded.'
      );
    }

    console.log('Report page detected at:', reportSurface.currentUrl);

    // Dropdown workflow
    let dropdownResult: {
      beforeViewReportCaptureCount: number;
      captureCountAtRenderComplete?: number;
    } = { beforeViewReportCaptureCount: getCaptureCount() };

    if (options.applySelects) {
      dropdownResult = await applyDropdownSelections(
        page,
        dropdownSteps,
        options,
        getCaptureCount
      );
    } else {
      console.log('Dropdown selection workflow skipped by option.');
    }

    // Wait for preferred capture
    const preferredOutcome = await ensurePreferredCapture(
      page,
      captures,
      dropdownResult.beforeViewReportCaptureCount,
      options,
      getCaptureCount
    );

    // Resolve selected capture
    const selectedCapture = preferredOutcome.selectedCapture;

    if (!selectedCapture) {
      throw new Error(
        'No preferred ctl09 network payload captured after report render. Increase PREFERRED_CAPTURE_TIMEOUT_MS or FORCED_ASYNC_RETRIES and re-run capture.'
      );
    }

    console.log('Selected bootstrap source:', preferredOutcome.selectedBootstrapSource);

    // Write selected curl only
    writeText(selectedCurlPath, `${buildCurlCommand(selectedCapture)}\n`);
    console.log('Selected curl written to:', selectedCurlPath);
    console.log('Done.');
  } finally {
    if (captureContext) {
      captureContext.detachCapture();
      captureContext.clearCaptures();
    }
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Capture failed:', message);
  process.exit(1);
});
