import fs from 'node:fs';
import path from 'node:path';
import type { PageInfo, ProductRow, ViewStates } from './types.js';

function detachString(value: string): string {
  if (!value) {
    return '';
  }

  return (` ${value}`).slice(1);
}

function saveDebugResponse(phase: string, responseData: string): string {
  const outputPath = path.resolve('outputs', `debug-${phase}-response.txt`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, String(responseData || ''), 'utf8');
  return outputPath;
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function toPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function cleanDescription(value: string): string {
  return value.replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitSupplierAndArticleLinking(value: string): { supplier: string; article_linking: string } {
  const cleaned = value
    .replace(/\s+Page\s+\d+\s+of\s+\d+\s*$/i, '')
    .replace(/\s+EAN\/PLU\s+Root\s+Article\s+Code[\s\S]*$/i, '')
    .replace(/\s+[A-Z]\d{4}\s+-\s+[\s\S]*$/i, '')
    .trim();

  if (!cleaned) {
    return {
      supplier: '',
      article_linking: '',
    };
  }

  const articleMatch = cleaned.match(/\s+(\*|\d{6,8}-\d{3})$/);
  if (!articleMatch || articleMatch.index === undefined) {
    return {
      supplier: cleaned,
      article_linking: '',
    };
  }

  return {
    supplier: cleaned.slice(0, articleMatch.index).trim(),
    article_linking: articleMatch[1],
  };
}

export function extractReportHtml(responseData: string, phase = 'request'): string {
  const responseText = String(responseData || '');

  // Preferred SSRS delta block that contains the rendered report area.
  const reportAreaMatch = responseText.match(
    /\|updatePanel\|ReportViewerControl_ctl09_ReportArea\|([\s\S]*?)\|\d+\|hiddenField\|__EVENTTARGET\|/
  );

  let reportHtml = '';

  if (reportAreaMatch && reportAreaMatch[1]) {
    reportHtml = detachString(reportAreaMatch[1]);
  } else {
    const fullPanelMatch = responseText.match(
      /\|updatePanel\|ReportViewerControl_ReportViewer\|([\s\S]*?)\|\d+\|hiddenField\|__EVENTTARGET\|/
    );

    if (!fullPanelMatch || !fullPanelMatch[1]) {
      const debugPath = saveDebugResponse(phase, responseText);
      const preview = toPlainText(responseText).slice(0, 250);
      throw new Error(
        `Could not extract ReportArea HTML from ${phase} response. Saved raw response to ${debugPath}. Preview: ${preview}`
      );
    }

    reportHtml = detachString(fullPanelMatch[1]);
  }

  if (
    reportHtml.includes('ReportAreaContent.Error') ||
    reportHtml.includes('VisibilityState$ctl00" value="Error"')
  ) {
    const debugPath = saveDebugResponse(phase, responseText);
    throw new Error(`SSRS returned ReportArea error content on ${phase}. Saved raw response to ${debugPath}`);
  }

  if (
    reportHtml.includes('ReportAreaContent.None') ||
    reportHtml.includes('VisibilityState$ctl00" value="None"')
  ) {
    const debugPath = saveDebugResponse(phase, responseText);
    throw new Error(
      `SSRS returned no report content on ${phase} (parameters unresolved or invalid). Saved raw response to ${debugPath}`
    );
  }

  return reportHtml;
}

export function extractStates(responseData: string): ViewStates {
  const viewStateMatch = responseData.match(/\|hiddenField\|__VIEWSTATE\|([^|]+)\|/);
  const newViewStateMatch = responseData.match(
    /name="NavigationCorrector\$NewViewState"[^>]*value="([^"]+)"/
  );

  if (!viewStateMatch || !viewStateMatch[1]) {
    throw new Error('Could not extract __VIEWSTATE from response.');
  }

  if (!newViewStateMatch || !newViewStateMatch[1]) {
    throw new Error('Could not extract NavigationCorrector$NewViewState from response.');
  }

  return {
    viewState: detachString(viewStateMatch[1]),
    newViewState: detachString(decodeHtmlEntities(newViewStateMatch[1])),
  };
}

export function extractPageInfo(reportHtml: string, responseData: string): PageInfo {
  const reportText = toPlainText(reportHtml);
  const pageMatch = reportText.match(/\bPage\s+(\d+)\s+of\s+(\d+)\b/i);

  if (pageMatch) {
    return {
      currentPage: Number.parseInt(pageMatch[1], 10),
      totalPages: Number.parseInt(pageMatch[2], 10),
    };
  }

  const currentPageFallback = responseData.match(/'CurrentPage':\s*(\d+)/);
  const totalPagesFallback = responseData.match(/'TotalPagesString':'(\d+)'/);
  if (currentPageFallback && totalPagesFallback) {
    return {
      currentPage: Number.parseInt(currentPageFallback[1], 10),
      totalPages: Number.parseInt(totalPagesFallback[1], 10),
    };
  }

  return {
    currentPage: 1,
    totalPages: 1,
  };
}

export function extractProducts(reportHtml: string, pageNumber: number): ProductRow[] {
  const text = toPlainText(reportHtml);
  const rowStartPattern = /\b\d{5,14}(?:\s+\d{6,8})?\s+[A-Z]{2,4}\s+\d+\s+\d+\s+/g;
  const rowStartIndices: number[] = [];

  let startMatch = rowStartPattern.exec(text);
  while (startMatch !== null) {
    rowStartIndices.push(startMatch.index);
    startMatch = rowStartPattern.exec(text);
  }

  const rows: ProductRow[] = [];

  for (let index = 0; index < rowStartIndices.length; index += 1) {
    const startIndex = rowStartIndices[index];
    const endIndex = index + 1 < rowStartIndices.length ? rowStartIndices[index + 1] : text.length;
    const chunk = text
      .slice(startIndex, endIndex)
      .replace(/\s+Page\s+\d+\s+of\s+\d+\s*$/i, '')
      .trim();

    const headMatch = chunk.match(
      /^(\d{5,14})(?:\s+(\d{6,8}))?\s+([A-Z]{2,4})\s+(\d+)\s+(\d+)\s+([\s\S]+)$/
    );

    if (!headMatch) {
      continue;
    }

    const tail = headMatch[6];
    const detailMatch = tail.match(
      /^([\s\S]+?)\s+([YN])(?:\s+([YN]))?\s+\u20ac([0-9]+\.[0-9]{2})\s+\u20ac([0-9]+\.[0-9]{2})\s+([0-9]+\.[0-9]{2}%?)\s+(\d+)\s+([0-9]+\.[0-9]{2}%?)\s+([YN])\s+([\s\S]+)$/
    );

    if (!detailMatch) {
      continue;
    }

    const supplierFields = splitSupplierAndArticleLinking(detailMatch[10]);

    rows.push({
      page: pageNumber,
      ean_plu: headMatch[1],
      root_article_code: headMatch[2] || '',
      lu: headMatch[3],
      lv: headMatch[4],
      sv_code: headMatch[5],
      description: cleanDescription(detailMatch[1]),
      must_stock: detailMatch[2],
      delisted: detailMatch[3] || '',
      store_selling_price: detailMatch[4],
      cost_price: detailMatch[5],
      vat: detailMatch[6],
      case_qty: detailMatch[7],
      margin_percent: detailMatch[8],
      drs: detailMatch[9],
      supplier: supplierFields.supplier,
      article_linking: supplierFields.article_linking,
    });
  }

  return rows;
}
