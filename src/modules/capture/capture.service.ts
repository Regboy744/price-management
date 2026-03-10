import path from 'node:path';
import { DEFAULT_REPORT_URL } from '../../../config/report.js';
import type { AppEnvironment } from '../../config/env.js';
import { resolveJobFile } from '../../config/paths.js';
import { ValidationError } from '../../shared/errors/app-error.js';
import type { CaptureOptions } from '../../types.js';
import type { JobRunnerContext } from '../jobs/job.types.js';
import { runCaptureWorkflow } from './capture-workflow.js';
import type { CaptureJobRequest, CaptureJobResult } from './capture.types.js';

function resolveUserDataDir(
  inputPath: string | undefined,
  defaultPath: string,
  jobDirectory: string
): string {
  if (inputPath) {
    return path.resolve(inputPath);
  }

  const defaultBase = path.basename(defaultPath);
  return path.join(jobDirectory, defaultBase || 'browser-profile');
}

export class CaptureService {
  constructor(private readonly env: AppEnvironment) {}

  async execute(input: CaptureJobRequest, context: JobRunnerContext): Promise<CaptureJobResult> {
    const options = this.buildOptions(input, context.jobDirectory);
    this.validateOptions(options);

    return runCaptureWorkflow({
      options,
      logger: context.logger,
      paths: {
        selectedCurlPath: resolveJobFile(
          context.jobDirectory,
          input.outputFileName,
          'selected-report-request.curl.sh'
        ),
        payloadDirPath: path.join(context.jobDirectory, 'payloads'),
        payloadIndexPath: path.join(context.jobDirectory, 'payload-index.json'),
        curlDirPath: path.join(context.jobDirectory, 'captured-curls'),
        curlBundlePath: path.join(context.jobDirectory, 'captured-requests.curl.sh'),
        summaryPath: path.join(context.jobDirectory, 'capture-summary.json'),
        failureScreenshotPath: path.join(context.jobDirectory, 'capture-failure.png'),
        failureHtmlPath: path.join(context.jobDirectory, 'capture-failure.html'),
      },
    });
  }

  private buildOptions(input: CaptureJobRequest, jobDirectory: string): CaptureOptions {
    return {
      reportUrl: input.reportUrl || this.env.captureDefaults.reportUrl || DEFAULT_REPORT_URL,
      sessionFile: path.join(jobDirectory, 'session.ts'),
      chromePath: input.chromePath || this.env.browser.chromePath,
      userDataDir: resolveUserDataDir(
        input.userDataDir,
        this.env.storage.defaultUserDataDir,
        jobDirectory
      ),
      headless: input.headless ?? this.env.captureDefaults.headless,
      timeoutMs: input.timeoutMs ?? this.env.captureDefaults.timeoutMs,
      autoLogin: input.autoLogin ?? this.env.auth.autoLogin,
      username: input.username ?? this.env.auth.username,
      password: input.password ?? this.env.auth.password,
      keepSignedIn: input.keepSignedIn ?? this.env.auth.keepSignedIn,
      applySelects: input.applySelects ?? this.env.captureDefaults.applySelects,
      selectDelayMs: input.selectDelayMs ?? this.env.captureDefaults.selectDelayMs,
      browserActionTimeoutMs:
        input.browserActionTimeoutMs ?? this.env.captureDefaults.browserActionTimeoutMs,
      selectPostbackTimeoutMs:
        input.selectPostbackTimeoutMs ?? this.env.captureDefaults.selectPostbackTimeoutMs,
      freshProfile: input.freshProfile ?? this.env.captureDefaults.freshProfile,
      renderTimeoutMs: input.renderTimeoutMs ?? this.env.captureDefaults.renderTimeoutMs,
      postRenderCaptureWaitMs:
        input.postRenderCaptureWaitMs ?? this.env.captureDefaults.postRenderCaptureWaitMs,
      preferredCaptureTimeoutMs:
        input.preferredCaptureTimeoutMs ?? this.env.captureDefaults.preferredCaptureTimeoutMs,
      forcedAsyncRetries: input.forcedAsyncRetries ?? this.env.captureDefaults.forcedAsyncRetries,
    };
  }

  private validateOptions(options: CaptureOptions): void {
    if (options.autoLogin && (!options.username || !options.password)) {
      throw new ValidationError(
        'Capture autoLogin requires username and password, either in the request body or environment variables.'
      );
    }

    if (!options.autoLogin && options.freshProfile) {
      throw new ValidationError(
        'Capture jobs require autoLogin or a reusable authenticated browser profile with freshProfile=false.'
      );
    }

    if (options.headless && !options.autoLogin && options.freshProfile) {
      throw new ValidationError(
        'Headless capture jobs require autoLogin or a reusable authenticated browser profile.'
      );
    }
  }
}
