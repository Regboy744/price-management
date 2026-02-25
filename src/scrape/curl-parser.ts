import fs from 'node:fs';
import path from 'node:path';
import type { ParsedCurl } from './types.js';

// Matches the shell-safe single quote sequence produced by shellSingleQuote.
const SHELL_SINGLE_QUOTE_ESCAPE = `'"'"'`;

function stripLineContinuation(line: string): string {
  const trimmed = line.trim();
  if (trimmed.endsWith('\\')) {
    return trimmed.slice(0, -1).trimEnd();
  }
  return trimmed;
}

function decodeSingleQuotedToken(token: string): string {
  const trimmed = token.trim();

  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) {
    throw new Error(`Expected single-quoted curl token, got: ${trimmed.slice(0, 80)}`);
  }

  return trimmed.slice(1, -1).replaceAll(SHELL_SINGLE_QUOTE_ESCAPE, "'");
}

function splitHeader(rawHeader: string): [string, string] {
  const separatorIndex = rawHeader.indexOf(':');
  if (separatorIndex <= 0) {
    throw new Error(`Invalid curl header format: ${rawHeader}`);
  }

  const name = rawHeader.slice(0, separatorIndex).trim();
  const value = rawHeader.slice(separatorIndex + 1).trim();
  return [name, value];
}

export function parseCurlCommand(rawCommand: string): ParsedCurl {
  const lines = rawCommand
    .split(/\r?\n/)
    .map(stripLineContinuation)
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('#'));

  let requestUrl = '';
  let cookieString = '';
  let body = '';
  const headers: Record<string, string> = {};

  for (const line of lines) {
    if (line.startsWith('curl ')) {
      requestUrl = decodeSingleQuotedToken(line.slice(5));
      continue;
    }

    if (line.startsWith('-H ')) {
      const headerToken = decodeSingleQuotedToken(line.slice(3));
      const [name, value] = splitHeader(headerToken);
      headers[name] = value;
      continue;
    }

    if (line.startsWith('-b ')) {
      cookieString = decodeSingleQuotedToken(line.slice(3));
      continue;
    }

    if (line.startsWith('--cookie ')) {
      cookieString = decodeSingleQuotedToken(line.slice('--cookie '.length));
      continue;
    }

    if (line.startsWith('--data-raw ')) {
      body = decodeSingleQuotedToken(line.slice('--data-raw '.length));
      continue;
    }

    if (line.startsWith('--data ')) {
      body = decodeSingleQuotedToken(line.slice('--data '.length));
      continue;
    }

    if (line.startsWith('--data-binary ')) {
      body = decodeSingleQuotedToken(line.slice('--data-binary '.length));
      continue;
    }
  }

  if (!requestUrl) {
    throw new Error('Could not parse request URL from curl command.');
  }

  if (!body) {
    throw new Error('Could not parse --data-raw body from curl command.');
  }

  if (!cookieString) {
    cookieString = headers['Cookie'] || headers['cookie'] || '';
  }

  delete headers['Cookie'];
  delete headers['cookie'];

  return {
    requestUrl,
    headers,
    cookieString,
    body,
  };
}

export function parseCurlFile(filePath: string): ParsedCurl {
  const resolvedPath = path.resolve(filePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Curl file not found: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  return parseCurlCommand(raw);
}
