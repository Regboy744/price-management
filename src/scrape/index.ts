import path from 'node:path';
import { formData, pagination } from '../../config/ssrs.js';
import { envBool } from '../utils.js';
import { parseCurlFile } from './curl-parser.js';
import { writeCsv } from './output.js';
import { buildBootstrapFormParams } from './pagination.js';
import { scrapeFromBootstrap } from './runner.js';
import type { FormOverrideChange, ScrapeOptions } from './types.js';

function toNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function logFormOverridePreview(changedKeys: FormOverrideChange[], skippedKeys: string[]): void {
  if (changedKeys.length === 0) {
    console.log('No config form overrides applied (curl body already matches configured values).');
  } else {
    console.log(`Applied ${changedKeys.length} config form overrides.`);
    const previewLimit = 12;
    for (const change of changedKeys.slice(0, previewLimit)) {
      console.log(`  ${change.key}: ${change.from} -> ${change.to}`);
    }
    if (changedKeys.length > previewLimit) {
      console.log(`  ...and ${changedKeys.length - previewLimit} more overrides.`);
    }
  }

  if (skippedKeys.length > 0) {
    console.log(`Skipped ${skippedKeys.length} override keys absent from captured curl payload.`);
  }
}

function parseArgs(argv: string[]): ScrapeOptions {
  const options: ScrapeOptions = {
    curlFile: path.join('outputs', 'selected-report-request.curl.sh'),
    outputCsvFile: path.join('outputs', 'products.csv'),
    maxPages: null,
    requestDelayMs: null,
    skipFormOverrides: envBool(process.env['SCRAPE_SKIP_FORM_OVERRIDES'], false),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--':
        break;
      case '--curl-file':
        if (!next) throw new Error('Missing value for --curl-file');
        options.curlFile = next;
        index += 1;
        break;
      case '--output':
      case '--output-csv':
        if (!next) throw new Error(`Missing value for ${arg}`);
        options.outputCsvFile = next;
        index += 1;
        break;
      case '--max-pages':
        if (!next) throw new Error('Missing value for --max-pages');
        options.maxPages = toNonNegativeInteger(next, 0);
        if (options.maxPages === 0) {
          throw new Error('--max-pages must be greater than zero');
        }
        index += 1;
        break;
      case '--request-delay-ms':
        if (!next) throw new Error('Missing value for --request-delay-ms');
        options.requestDelayMs = toNonNegativeInteger(next, 0);
        index += 1;
        break;
      case '--skip-form-overrides':
        options.skipFormOverrides = true;
        break;
      case '--apply-form-overrides':
        options.skipFormOverrides = false;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (arg && !arg.startsWith('-')) {
          options.outputCsvFile = arg;
          break;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printUsage(): void {
  console.log('Usage: pnpm scrape [options] [output-csv]');
  console.log('');
  console.log('Options:');
  console.log('  --curl-file <path>          Captured curl file to replay');
  console.log('  --output <path>             CSV output path (default: outputs/products.csv)');
  console.log('  --max-pages <n>             Scrape at most N pages');
  console.log('  --request-delay-ms <ms>     Delay between requests');
  console.log('  --skip-form-overrides       Ignore config formData overrides');
  console.log('  --apply-form-overrides      Apply config formData overrides');
  console.log('  --help                      Show this help');
  console.log('');
  console.log('Env vars: REQUEST_DELAY_MS, SCRAPE_SKIP_FORM_OVERRIDES');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  const curlPath = path.resolve(options.curlFile);
  const outputCsvFile = path.resolve(options.outputCsvFile);

  const parsedCurl = parseCurlFile(curlPath);
  if (!parsedCurl.cookieString) {
    throw new Error('No cookie string found in captured curl file. Re-run capture and try again.');
  }

  const delayMs =
    options.requestDelayMs ??
    toNonNegativeInteger(process.env['REQUEST_DELAY_MS'], pagination.delayBetweenRequests);

  const { params: baseFormParams, changedKeys, skippedKeys } = buildBootstrapFormParams(
    parsedCurl.body,
    formData,
    !options.skipFormOverrides
  );

  console.log('Starting scrape using:', path.relative(process.cwd(), curlPath));
  console.log('Target URL:', parsedCurl.requestUrl);
  console.log('Delay between requests (ms):', delayMs);
  console.log('Page limit:', options.maxPages ?? 'all');

  if (options.skipFormOverrides) {
    console.log('Form overrides disabled.');
  } else {
    logFormOverridePreview(changedKeys, skippedKeys);
  }

  const result = await scrapeFromBootstrap(
    {
      requestUrl: parsedCurl.requestUrl,
      requestHeaders: parsedCurl.headers,
      cookieString: parsedCurl.cookieString,
      bootstrapBody: baseFormParams.toString(),
      delayMs,
      maxPages: options.maxPages,
    },
    {
      collectRows: true,
      phasePrefix: 'single-curl',
      onPageRows: (rows, page) => {
        console.log(`Collected page ${page.currentPage} of ${page.totalPages}: ${rows.length} rows`);
      },
    }
  );

  writeCsv(result.rows, outputCsvFile);

  console.log('Done.');
  console.log('CSV:', outputCsvFile);
  console.log(`Rows: ${result.totalRows}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Scrape failed:', message);
  process.exit(1);
});
