import path from 'node:path';
import { formData } from '../../../config/ssrs.js';
import type { AppEnvironment } from '../../config/env.js';
import { resolveJobFile } from '../../config/paths.js';
import { writeJson } from '../../output.js';
import { buildBootstrapFormParams } from '../../scrape/pagination.js';
import { parseCurlFile } from '../../scrape/curl-parser.js';
import { writeCsv } from '../../scrape/output.js';
import { scrapeFromBootstrap } from '../../scrape/runner.js';
import { ValidationError } from '../../shared/errors/app-error.js';
import type { JobRunnerContext } from '../jobs/job.types.js';
import type { ReplayJobExecutionInput, ReplayJobResult } from './replay.types.js';

export class ReplayService {
  constructor(private readonly env: AppEnvironment) {}

  async execute(input: ReplayJobExecutionInput, context: JobRunnerContext): Promise<ReplayJobResult> {
    const outputCsvPath = resolveJobFile(context.jobDirectory, input.outputFileName, 'products.csv');
    const summaryPath = path.join(context.jobDirectory, 'replay-summary.json');
    const parsedCurl = parseCurlFile(path.resolve(input.curlFilePath));

    if (!parsedCurl.cookieString) {
      throw new ValidationError(
        'No cookie string was found in the provided curl file. Re-run capture and try again.'
      );
    }

    const requestDelayMs = input.requestDelayMs ?? this.env.replayDefaults.requestDelayMs;
    const applyFormOverrides = input.applyFormOverrides ?? this.env.replayDefaults.applyFormOverrides;

    const { params: baseFormParams, changedKeys, skippedKeys } = buildBootstrapFormParams(
      parsedCurl.body,
      formData,
      applyFormOverrides
    );

    context.logger.info('Starting replay job', {
      curlFilePath: input.curlFilePath,
      sourceDescription: input.sourceDescription,
      outputCsvPath,
      requestDelayMs,
      applyFormOverrides,
      maxPages: input.maxPages ?? null,
    });

    const result = await scrapeFromBootstrap(
      {
        requestUrl: parsedCurl.requestUrl,
        requestHeaders: parsedCurl.headers,
        cookieString: parsedCurl.cookieString,
        bootstrapBody: baseFormParams.toString(),
        delayMs: requestDelayMs,
        maxPages: input.maxPages ?? null,
      },
      {
        collectRows: true,
        phasePrefix: 'api-replay',
        logLabel: `[job:${context.jobId}]`,
      }
    );

    writeCsv(result.rows, outputCsvPath);

    const replayResult: ReplayJobResult = {
      curlFilePath: path.resolve(input.curlFilePath),
      outputCsvPath,
      requestUrl: parsedCurl.requestUrl,
      totalRows: result.totalRows,
      pageCount: result.pagesScraped.length,
      pagesScraped: result.pagesScraped,
      rowsPerPage: result.rowsPerPage,
      requestDelayMs,
      sourceDescription: input.sourceDescription,
      appliedFormOverrides: applyFormOverrides,
      changedKeys: changedKeys.length,
      skippedKeys: skippedKeys.length,
    };

    writeJson(summaryPath, replayResult);
    context.logger.info('Replay job completed', {
      totalRows: replayResult.totalRows,
      pageCount: replayResult.pageCount,
      outputCsvPath,
    });

    return replayResult;
  }
}
