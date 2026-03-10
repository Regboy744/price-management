import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import type { Logger } from '../../config/logger.js';
import { AppError } from '../../shared/errors/app-error.js';
import { runAutomatedLogin } from '../../auth.js';
import { attachNetworkCapture, launchBrowser } from '../../browser.js';
import { buildCurlCommand, savePostRenderPayloads, writeJson, writeText } from '../../output.js';
import { ensurePreferredCapture, waitForReportSurface } from '../../report.js';
import type { CaptureOptions } from '../../types.js';
import { applyInitialCaptureSelections } from './capture-selection.js';
import type { CaptureJobResult } from './capture.types.js';

export interface CaptureWorkflowPaths {
  selectedCurlPath: string;
  payloadDirPath: string;
  payloadIndexPath: string;
  curlDirPath: string;
  curlBundlePath: string;
  summaryPath?: string;
  failureScreenshotPath?: string;
  failureHtmlPath?: string;
}

export interface CaptureWorkflowInput {
  options: CaptureOptions;
  logger: Logger;
  paths: CaptureWorkflowPaths;
}

async function saveFailureArtifacts(
  page: Page | null,
  logger: Logger,
  paths: CaptureWorkflowPaths
): Promise<void> {
  if (!page) {
    return;
  }

  if (paths.failureScreenshotPath) {
    fs.mkdirSync(path.dirname(paths.failureScreenshotPath), { recursive: true });
    await page.screenshot({ path: paths.failureScreenshotPath, fullPage: true }).catch(() => null);
  }

  if (paths.failureHtmlPath) {
    fs.mkdirSync(path.dirname(paths.failureHtmlPath), { recursive: true });
    const html = await page.content().catch(() => '');
    if (html) {
      fs.writeFileSync(paths.failureHtmlPath, html, 'utf8');
    }
  }

  logger.warn('Capture failure artifacts saved', {
    screenshotPath: paths.failureScreenshotPath || null,
    htmlPath: paths.failureHtmlPath || null,
  });
}

export async function runCaptureWorkflow(
  input: CaptureWorkflowInput
): Promise<CaptureJobResult> {
  const { options, logger, paths } = input;

  logger.info('Starting capture workflow', {
    reportUrl: options.reportUrl,
    headless: options.headless,
    autoLogin: options.autoLogin,
    freshProfile: options.freshProfile,
    userDataDir: options.userDataDir,
  });

  const browser = await launchBrowser(options);
  let captureContext: ReturnType<typeof attachNetworkCapture> | null = null;
  let page: Page | null = null;

  try {
    page = await browser.newPage();
    await page.bringToFront().catch(() => null);
    captureContext = attachNetworkCapture(page);
    const { captures, getCaptureCount } = captureContext;

    await page.goto(options.reportUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });

    if (options.autoLogin) {
      await runAutomatedLogin(page, options);
    }

    const reportSurface = await waitForReportSurface(page, options.timeoutMs);
    if (!reportSurface) {
      throw new AppError({
        message:
          'Could not detect the report surface. Use autoLogin credentials or a reusable authenticated browser profile with freshProfile=false.',
        statusCode: 500,
        code: 'REPORT_SURFACE_NOT_FOUND',
        expose: true,
      });
    }

    logger.info('Report surface detected', {
      currentUrl: reportSurface.currentUrl,
    });

    const dropdownResult = options.applySelects
      ? await applyInitialCaptureSelections({
          page,
          options,
          getCaptureCount,
          logger,
        })
      : {
          beforeViewReportCaptureCount: getCaptureCount(),
          selection: undefined,
        };

    if (!options.applySelects) {
      logger.info('Capture selection workflow skipped by configuration');
    }

    const preferredOutcome = await ensurePreferredCapture(
      page,
      captures,
      dropdownResult.beforeViewReportCaptureCount,
      options,
      getCaptureCount
    );

    const selectedCapture = preferredOutcome.selectedCapture;
    if (!selectedCapture) {
      throw new AppError({
        message:
          'No preferred ctl09 network payload was captured after report render. Increase preferredCaptureTimeoutMs or forcedAsyncRetries and try again.',
        statusCode: 500,
        code: 'CAPTURE_NOT_FOUND',
        expose: true,
      });
    }

    writeText(paths.selectedCurlPath, `${buildCurlCommand(selectedCapture)}\n`);

    const payloadRecords = savePostRenderPayloads(
      captures,
      paths.payloadDirPath,
      paths.payloadIndexPath,
      paths.curlDirPath,
      paths.curlBundlePath
    );

    const result: CaptureJobResult = {
      purpose: 'bootstrap-payload-capture',
      reportSurfaceUrl: reportSurface.currentUrl,
      selectedRequestUrl: selectedCapture.requestUrl,
      selectedCurlPath: paths.selectedCurlPath,
      selectedBootstrapSource: preferredOutcome.selectedBootstrapSource,
      selectedCaptureSequence: selectedCapture.sequence,
      selectedEventTarget: selectedCapture.eventTarget,
      captureCount: getCaptureCount(),
      forcedAsyncAttemptCount: preferredOutcome.forcedAsyncAttemptCount,
      forcedAsyncResults: preferredOutcome.forcedAsyncResults,
      payloadCount: payloadRecords.length,
      payloadIndexPath: paths.payloadIndexPath,
      curlBundlePath: paths.curlBundlePath,
      nextRecommendedJob: 'sweep',
      selection: dropdownResult.selection,
    };

    if (paths.summaryPath) {
      writeJson(paths.summaryPath, result);
    }

    logger.info('Capture workflow completed', {
      selectedCurlPath: paths.selectedCurlPath,
      payloadCount: payloadRecords.length,
      selection: dropdownResult.selection
        ? {
            store: dropdownResult.selection.store.text,
            department: dropdownResult.selection.department.text,
            subdepartment: dropdownResult.selection.subdepartment.text,
            commodity: dropdownResult.selection.commodity.text,
            family: dropdownResult.selection.family.text,
          }
        : null,
    });

    return result;
  } catch (error) {
    await saveFailureArtifacts(page, logger, paths);
    throw error;
  } finally {
    if (captureContext) {
      captureContext.detachCapture();
      captureContext.clearCaptures();
    }

    await browser.close();
  }
}
