import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import type { AuthSurfaceState, CaptureOptions } from './types.js';
import { sleep } from './utils.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function maskEmail(value: string): string {
  const [localPart, domainPart] = String(value || '').split('@');
  if (!domainPart) return `${localPart.slice(0, 2)}***`;
  if (localPart.length <= 2) return `***@${domainPart}`;
  return `${localPart.slice(0, 2)}***${localPart.slice(-1)}@${domainPart}`;
}

function isMicrosoftLoginHost(host: string): boolean {
  const h = (host || '').toLowerCase();
  return (
    h.includes('login.microsoftonline.com') ||
    h.endsWith('.microsoftonline.com') ||
    h === 'login.live.com' ||
    h === 'account.live.com' ||
    h.endsWith('.live.com')
  );
}

function hasReportSurface(state: AuthSurfaceState): boolean {
  return !state.isLoginHost && (state.hasReportForm || state.hasReportViewerControl);
}

async function dumpDebug(page: Page, label: string): Promise<string[]> {
  const outputDir = path.resolve('outputs');
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[.:]/g, '-');
  const files: string[] = [];

  const png = path.join(outputDir, `auth-${label}-${stamp}.png`);
  await page.screenshot({ path: png, fullPage: true }).catch(() => null);
  if (fs.existsSync(png)) files.push(png);

  const html = await page.content().catch(() => '');
  if (html) {
    const htmlPath = path.join(outputDir, `auth-${label}-${stamp}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');
    files.push(htmlPath);
  }

  return files;
}

/* ------------------------------------------------------------------ */
/*  Page state detection                                              */
/* ------------------------------------------------------------------ */

export async function getAuthSurfaceState(page: Page): Promise<AuthSurfaceState> {
  return page
    .evaluate(() => ({
      currentUrl: window.location.href,
      host: window.location.hostname,
      hasUsernameField: Boolean(document.getElementById('i0116')),
      hasPasswordField: Boolean(document.getElementById('i0118')),
      hasReportForm: Boolean(
        document.querySelector('form[action*="ReportViewer.aspx"], #ReportViewerForm')
      ),
      hasReportViewerControl: Boolean(
        document.querySelector('#ReportViewerControl, [id*="ReportViewerControl"]')
      ),
    }))
    .then((s) => ({
      currentUrl: s.currentUrl,
      isLoginHost: isMicrosoftLoginHost(s.host),
      hasUsernameField: s.hasUsernameField,
      hasPasswordField: s.hasPasswordField,
      hasReportForm: s.hasReportForm,
      hasReportViewerControl: s.hasReportViewerControl,
    }))
    .catch((): AuthSurfaceState => ({
      currentUrl: '',
      isLoginHost: false,
      hasUsernameField: false,
      hasPasswordField: false,
      hasReportForm: false,
      hasReportViewerControl: false,
    }));
}

export async function waitForLoginOrReportSurface(
  page: Page,
  timeoutMs: number
): Promise<AuthSurfaceState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await getAuthSurfaceState(page);
    if (s.isLoginHost || s.hasUsernameField || s.hasPasswordField || s.hasReportForm || s.hasReportViewerControl) {
      return s;
    }
    await sleep(300);
  }
  return getAuthSurfaceState(page);
}

/* ------------------------------------------------------------------ */
/*  Primitive: wait for an element by id                              */
/* ------------------------------------------------------------------ */

async function waitForElement(page: Page, id: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exists = await page.evaluate((eid) => Boolean(document.getElementById(eid)), id).catch(() => false);
    if (exists) return true;
    await sleep(250);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Primitive: click + type into a field using browser APIs only       */
/*  No DOM manipulation. No style changes. Just click → clear → type  */
/* ------------------------------------------------------------------ */

async function clickAndType(page: Page, selector: string, value: string): Promise<string> {
  // 1. Click the field: browser automation scrolls, focuses, and fires mouse events
  await page.click(selector).catch(() => null);
  await sleep(150);

  // 2. Triple-click to select all existing text (if any)
  await page.click(selector, { clickCount: 3 }).catch(() => null);
  await sleep(50);

  // 3. Delete selected text
  await page.keyboard.press('Backspace');
  await sleep(50);

  // 4. Type the value character by character — fires real keydown/input/keyup
  //    which Knockout textInput binding listens to
  await page.keyboard.type(value, { delay: 25 });
  await sleep(150);

  // 5. Read back
  const actual = await page
    .$eval(selector, (el) => (el as HTMLInputElement).value)
    .catch(() => '');

  return actual;
}

/* ------------------------------------------------------------------ */
/*  Step 1: Username                                                  */
/* ------------------------------------------------------------------ */

async function doUsernameStep(page: Page, username: string): Promise<void> {
  console.log('[auth] Step 1: waiting for username field #i0116...');

  const found = await waitForElement(page, 'i0116', 15_000);
  if (!found) {
    const files = await dumpDebug(page, 'no-username-field');
    throw new Error(`Username field #i0116 not found. Debug: ${files.join(', ')}`);
  }

  // Small delay for any page animation to settle
  await sleep(500);

  const typed = await clickAndType(page, '#i0116', username);
  console.log(`[auth] username typed: "${maskEmail(typed)}" (${typed.length} chars)`);

  if (typed !== username) {
    console.log(`[auth] WARNING: typed value doesn't match expected. Retrying...`);
    // Clear and try once more
    await sleep(200);
    const retry = await clickAndType(page, '#i0116', username);
    console.log(`[auth] retry typed: "${maskEmail(retry)}" (${retry.length} chars)`);
    if (retry !== username) {
      const files = await dumpDebug(page, 'username-mismatch');
      throw new Error(`Username field value mismatch after retry. Got "${maskEmail(retry)}". Debug: ${files.join(', ')}`);
    }
  }

  // Click the Next button
  console.log('[auth] clicking Next (#idSIButton9)...');
  await page.click('#idSIButton9').catch(() => null);
  await sleep(2_500);

  // Check for error message
  const errorText = await page
    .$eval('#usernameError', (el) => (el.textContent || '').trim())
    .catch(() => '');

  if (errorText) {
    const files = await dumpDebug(page, 'username-error');
    throw new Error(`Username rejected by Microsoft: "${errorText}". Debug: ${files.join(', ')}`);
  }

  console.log('[auth] Step 1 complete — username accepted.');
}

/* ------------------------------------------------------------------ */
/*  Step 2: Password                                                  */
/* ------------------------------------------------------------------ */

async function waitForPasswordField(page: Page, timeoutMs: number): Promise<boolean> {
  // Password field #i0118 exists on username page too but has class moveOffScreen.
  // We wait until either:
  //   a) #i0118 exists without moveOffScreen class, OR
  //   b) #passwordInput exists (alternate Entra layout)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => {
        const pw = document.getElementById('i0118') as HTMLInputElement | null;
        if (pw && !pw.classList.contains('moveOffScreen') && pw.getAttribute('aria-hidden') !== 'true') {
          return true;
        }
        // Alternate Entra password field
        const alt = document.getElementById('passwordInput') as HTMLInputElement | null;
        if (alt) return true;
        return false;
      })
      .catch(() => false);

    if (ready) return true;
    await sleep(300);
  }
  return false;
}

async function doPasswordStep(page: Page, password: string): Promise<void> {
  console.log('[auth] Step 2: waiting for password field...');

  const ready = await waitForPasswordField(page, 15_000);
  if (!ready) {
    // Maybe there's a "switch to password" link
    const switchLink = await page.$('#idA_PWD_SwitchToPassword');
    if (switchLink) {
      console.log('[auth] clicking "switch to password" link...');
      await switchLink.click();
      await sleep(1_500);
      const retryReady = await waitForPasswordField(page, 10_000);
      if (!retryReady) {
        const files = await dumpDebug(page, 'no-password-field');
        throw new Error(`Password field not found even after switch-to-password. Debug: ${files.join(', ')}`);
      }
    } else {
      const files = await dumpDebug(page, 'no-password-field');
      throw new Error(`Password field not found. Debug: ${files.join(', ')}`);
    }
  }

  await sleep(500);

  // Determine which password selector to use
  const pwSelector = await page.$('#passwordInput') ? '#passwordInput' : '#i0118';

  const typed = await clickAndType(page, pwSelector, password);
  console.log(`[auth] password typed (${typed.length} chars)`);

  if (!typed) {
    const files = await dumpDebug(page, 'password-empty');
    throw new Error(`Password field empty after typing. Debug: ${files.join(', ')}`);
  }

  // Click Sign in
  console.log('[auth] clicking Sign in (#idSIButton9)...');
  await page.click('#idSIButton9').catch(() => null);
  await sleep(3_000);

  console.log('[auth] Step 2 complete — password submitted.');
}

/* ------------------------------------------------------------------ */
/*  Step 3: KMSI (Keep Me Signed In) — click No                      */
/* ------------------------------------------------------------------ */

async function handleKmsiIfPresent(page: Page): Promise<void> {
  // Wait briefly for KMSI prompt
  const hasKmsi = await page
    .evaluate(() => Boolean(
      document.getElementById('KmsiDescription') ||
      document.getElementById('idBtn_Back')
    ))
    .catch(() => false);

  if (!hasKmsi) {
    // Wait a bit more — KMSI can appear after a redirect
    await sleep(2_000);
    const hasKmsiRetry = await page
      .evaluate(() => Boolean(
        document.getElementById('KmsiDescription') ||
        document.getElementById('idBtn_Back')
      ))
      .catch(() => false);

    if (!hasKmsiRetry) return;
  }

  console.log('[auth] KMSI prompt detected — clicking No...');
  await page.click('#idBtn_Back').catch(async () => {
    // Fallback: try the Yes button to just move past it
    await page.click('#idSIButton9').catch(() => null);
  });
  await sleep(2_000);
}

/* ------------------------------------------------------------------ */
/*  Account picker handling                                           */
/* ------------------------------------------------------------------ */

async function handleAccountPickerIfPresent(page: Page): Promise<boolean> {
  // Check if we're on an account picker page (tiles visible, no username field)
  const hasTiles = await page
    .evaluate(() => Boolean(
      document.getElementById('tilesHolder') ||
      document.getElementById('otherTile')
    ))
    .catch(() => false);

  if (!hasTiles) return false;

  console.log('[auth] account picker detected — clicking "Use another account"...');

  // Try clicking "Use another account"
  const clicked = await page.click('#otherTile').catch(() => null);
  if (clicked !== null) {
    await sleep(1_500);
    return true;
  }

  // Try alternate selectors
  for (const sel of ['[data-test-id="otherTile"]', '#use_another_account']) {
    const el = await page.$(sel);
    if (el) {
      await el.click();
      await sleep(1_500);
      return true;
    }
  }

  return false;
}

/* ------------------------------------------------------------------ */
/*  Main login flow                                                   */
/* ------------------------------------------------------------------ */

export async function runAutomatedLogin(page: Page, options: CaptureOptions): Promise<void> {
  if (!options.username || !options.password) {
    throw new Error('Auto-login requires MS_USERNAME and MS_PASSWORD in .env');
  }

  if (!options.headless) {
    await page.bringToFront().catch(() => null);
  }

  console.log('[auth] starting automated login...');
  console.log('[auth] username:', maskEmail(options.username));

  // Wait for page to load something meaningful
  let state = await waitForLoginOrReportSurface(page, 15_000);
  console.log(`[auth] initial: host=${new URL(state.currentUrl).hostname} loginHost=${state.isLoginHost} report=${state.hasReportForm || state.hasReportViewerControl}`);

  // Already authenticated?
  if (hasReportSurface(state)) {
    console.log('[auth] already authenticated.');
    return;
  }

  // Handle account picker if present
  await handleAccountPickerIfPresent(page);

  // Step 1: Username
  await doUsernameStep(page, options.username);

  // After username submission, we might land on:
  //   - Password page (most common)
  //   - Entra redirect to org IdP
  //   - KMSI prompt (if already cached somehow)
  //   - Report page (SSO)

  // Check if we already reached the report
  state = await getAuthSurfaceState(page);
  if (hasReportSurface(state)) {
    console.log('[auth] authenticated after username step (SSO).');
    return;
  }

  // Step 2: Password
  await doPasswordStep(page, options.password);

  // Check if we reached report
  state = await getAuthSurfaceState(page);
  if (hasReportSurface(state)) {
    console.log('[auth] authenticated after password step.');
    return;
  }

  // Step 3: KMSI
  await handleKmsiIfPresent(page);

  // Final wait for report surface (redirects can take time)
  console.log('[auth] waiting for report surface after login...');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    state = await getAuthSurfaceState(page);
    if (hasReportSurface(state)) {
      console.log('[auth] authenticated — report surface detected.');
      return;
    }

    // Handle any late KMSI prompt
    const kmsi = await page.$('#idBtn_Back');
    if (kmsi) {
      console.log('[auth] late KMSI prompt — clicking No...');
      await kmsi.click().catch(() => null);
      await sleep(2_000);
      continue;
    }

    await sleep(1_000);
  }

  // If we're still here, dump debug info
  const files = await dumpDebug(page, 'login-failed');
  state = await getAuthSurfaceState(page);
  throw new Error(
    `Login did not reach report page. ` +
    `host=${new URL(state.currentUrl).hostname} ` +
    `loginHost=${state.isLoginHost} report=${state.hasReportForm || state.hasReportViewerControl}. ` +
    `Debug: ${files.join(', ')}`
  );
}
