import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import type { ProductRow } from './types.js';

export function sanitizeStoreName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown-store';
}

const csvColumns: Array<{ label: string; key: keyof ProductRow }> = [
  { label: 'Department', key: 'department' },
  { label: 'Sub Department', key: 'subdepartment' },
  { label: 'Commodity Code', key: 'commodity_code' },
  { label: 'Family Group', key: 'family_group' },
  { label: 'EAN/PLU', key: 'ean_plu' },
  { label: 'Root Article Code', key: 'root_article_code' },
  { label: 'LU', key: 'lu' },
  { label: 'LV', key: 'lv' },
  { label: 'SV Code', key: 'sv_code' },
  { label: 'Description', key: 'description' },
  { label: 'Size', key: 'size' },
  { label: 'Must Stock', key: 'must_stock' },
  { label: 'Delisted', key: 'delisted' },
  { label: 'Store Selling Price', key: 'store_selling_price' },
  { label: 'Cost Price', key: 'cost_price' },
  { label: 'Vat', key: 'vat' },
  { label: 'Case Qty', key: 'case_qty' },
  { label: 'Margin %', key: 'margin_percent' },
  { label: 'DRS', key: 'drs' },
  { label: 'Supplier', key: 'supplier' },
  { label: 'Article Linking', key: 'article_linking' },
];

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function escapeCsv(value: unknown): string {
  const stringValue = value === undefined || value === null ? '' : String(value);
  if (!/[",\n]/.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function rowValues(row: ProductRow): string[] {
  return csvColumns.map((column) => escapeCsv(row[column.key]));
}

async function writeChunk(stream: fs.WriteStream, chunk: string): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, 'drain');
  }
}

export interface ProductsCsvAppender {
  filePath: string;
  appendRows: (rows: ProductRow[], storeName: string) => Promise<number>;
  close: () => Promise<void>;
}

export function createProductsCsvAppender(filePath: string): ProductsCsvAppender {
  ensureDir(filePath);

  const stream = fs.createWriteStream(filePath, {
    flags: 'w',
    encoding: 'utf8',
  });

  const header = ['Store Name', ...csvColumns.map((column) => column.label)].join(',');
  let closed = false;
  let queue: Promise<void> = writeChunk(stream, `${header}\n`);

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  return {
    filePath,
    appendRows: (rows: ProductRow[], storeName: string): Promise<number> =>
      enqueue(async () => {
        if (closed) {
          throw new Error(`CSV appender is closed: ${filePath}`);
        }

        if (!rows.length) {
          return 0;
        }

        const safeStoreName = escapeCsv(storeName);
        const lines = rows.map((row) => [safeStoreName, ...rowValues(row)].join(','));
        await writeChunk(stream, `${lines.join('\n')}\n`);
        return rows.length;
      }),
    close: (): Promise<void> =>
      enqueue(async () => {
        if (closed) {
          return;
        }
        closed = true;

        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          stream.once('error', onError);
          stream.end(() => {
            stream.off('error', onError);
            resolve();
          });
        });
      }),
  };
}

export function writeCsv(rows: ProductRow[], filePath: string): void {
  const lines = [csvColumns.map((column) => column.label).join(',')];

  for (const row of rows) {
    lines.push(rowValues(row).join(','));
  }

  ensureDir(filePath);
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}
