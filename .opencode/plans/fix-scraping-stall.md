# Fix: Scraping Stall After Fresh-Tab Resume

## Root Cause

When the SSRS page becomes unresponsive and a `SweepResumeRequiredError` triggers, the `finally` block in `processStore()` (`src/scrape/parallel.ts:353-367`) calls `page.goto('about:blank')`. This call inherits the page's default navigation timeout of **5 minutes** (set at line 229 from `captureOptions.timeoutMs` = `REPORT_SURFACE_TIMEOUT_MS` = 300,000ms).

Combined with subsequent timeout cascades on the new page (2 min navigation + 5 min surface detection), each resume attempt creates up to **12 minutes** of apparent inactivity with only memory telemetry output. With 25 max resumes per store, worst case is hours of silence.

## Changes

### File: `src/scrape/parallel.ts`

#### 1. Add `withTimeout` import (line 9)

```diff
-import { resolveBrowserActionTimeoutMs, sleep } from '../utils.js';
+import { resolveBrowserActionTimeoutMs, sleep, withTimeout } from '../utils.js';
```

#### 2. Add `PAGE_CLOSE_TIMEOUT_MS` constant and `readStoreWallClockTimeoutMs` helper (after line 57)

```typescript
const PAGE_CLOSE_TIMEOUT_MS = 5_000;

function readStoreWallClockTimeoutMs(): number {
  return Math.max(0, envNonNegativeInteger('STORE_WALL_CLOCK_TIMEOUT_MS', 0));
}
```

#### 3. Replace the `finally` block in `processStore()` (lines 353-367)

**Before:**
```typescript
      } finally {
        if (detachDiagnostics) {
          detachDiagnostics();
        }

        if (captureContext) {
          captureContext.detachCapture();
          captureContext.clearCaptures();
        }

        if (page) {
          await page.goto('about:blank').catch(() => null);
          await page.close().catch(() => null);
        }
      }
```

**After:**
```typescript
      } finally {
        if (detachDiagnostics) {
          detachDiagnostics();
        }

        if (captureContext) {
          captureContext.detachCapture();
          captureContext.clearCaptures();
        }

        if (page) {
          console.log(`${storeLabel}: closing tab...`);
          await Promise.race([
            page.close().catch(() => null),
            sleep(PAGE_CLOSE_TIMEOUT_MS),
          ]);
        }
      }
```

#### 4. Add `'could not detect report surface'` to `isRetriableStoreError()` (line 82-98)

**Before:**
```typescript
function isRetriableStoreError(message: string): boolean {
  const normalized = String(message || '').toLowerCase();

  return [
    'timeout',
    'target page, context or browser has been closed',
    'execution context was destroyed',
    'frame was detached',
    'navigation failed',
    'net::',
    'protocol error',
    'connection closed',
    'econnreset',
    'etimedout',
    'socket hang up',
    'dropdown stayed disabled',
    'error state after view report',
    'report viewer returned error',
  ].some((token) => normalized.includes(token));
}
```

**After:**
```typescript
function isRetriableStoreError(message: string): boolean {
  const normalized = String(message || '').toLowerCase();

  return [
    'timeout',
    'target page, context or browser has been closed',
    'execution context was destroyed',
    'frame was detached',
    'navigation failed',
    'net::',
    'protocol error',
    'connection closed',
    'econnreset',
    'etimedout',
    'socket hang up',
    'dropdown stayed disabled',
    'error state after view report',
    'report viewer returned error',
    'could not detect report surface',
  ].some((token) => normalized.includes(token));
}
```

#### 5. Add per-store wall-clock timeout in the batch loop (lines 450-466)

**Before:**
```typescript
    const batchPromises = batch.map((store, indexInBatch) => {
      const globalIndex = batchStart + indexInBatch;
      const csvPath = generateStoreCsvPath(input.outputDir, store);

      return processStore(
        input.browser,
        store,
        input.captureOptions,
        input.requestDelayMs,
        input.limits,
        csvPath,
        input.errorLogPath,
        globalIndex,
        stores.length,
        indexInBatch * staggerMs
      );
    });
```

**After:**
```typescript
    const storeWallClockTimeoutMs = readStoreWallClockTimeoutMs();

    const batchPromises = batch.map((store, indexInBatch) => {
      const globalIndex = batchStart + indexInBatch;
      const csvPath = generateStoreCsvPath(input.outputDir, store);

      const storePromise = processStore(
        input.browser,
        store,
        input.captureOptions,
        input.requestDelayMs,
        input.limits,
        csvPath,
        input.errorLogPath,
        globalIndex,
        stores.length,
        indexInBatch * staggerMs
      );

      if (storeWallClockTimeoutMs <= 0) {
        return storePromise;
      }

      return withTimeout(
        storePromise,
        storeWallClockTimeoutMs,
        () => new Error(`Store ${store.text} exceeded wall-clock timeout of ${storeWallClockTimeoutMs}ms`)
      ).catch((error): ParallelStoreResult => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[tab-${globalIndex + 1}/${stores.length}] ${message}`);
        appendError(input.errorLogPath, message);
        return {
          storeName: store.text,
          storeValue: store.value,
          csvPath,
          stats: createEmptyStats(),
          error: message,
        };
      });
    });
```

## Environment Variable

A new optional environment variable is introduced:

- **`STORE_WALL_CLOCK_TIMEOUT_MS`** — Maximum wall-clock time (in ms) for processing a single store. Default `0` (no limit). Recommended value: `1800000` (30 minutes).

## Summary of Impact

| Fix | Impact |
|-----|--------|
| Remove `page.goto('about:blank')` + add timeout to `page.close()` | Reduces cleanup hang from **5 minutes** to **5 seconds** |
| Add cleanup logging | Users see "closing tab..." during recovery instead of silence |
| Add `'could not detect report surface'` to retriable errors | SSRS temporary downtime triggers retry instead of permanent failure |
| Per-store wall-clock timeout | Prevents any single store from blocking the batch indefinitely |
