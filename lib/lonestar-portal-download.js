/**
 * Download Lone Star Bank eStatement PDF from my.lsbtexas.com (Banno).
 * Requires LONESTAR_ONLINE_USER + LONESTAR_ONLINE_PASSWORD on the server.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { getLonestarPortalConfig } from './lonestar-estatement-notify.js';
import { ensurePlaywrightBrowsers, getPlaywrightBrowsersPath } from './playwright-browsers.js';

let playwrightModule = null;

async function loadPlaywright() {
  if (playwrightModule) return playwrightModule;
  try {
    playwrightModule = await import('playwright');
    return playwrightModule;
  } catch {
    throw new Error(
      'Playwright is not installed. Run: npm install && npx playwright install chromium'
    );
  }
}

function isPdfBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length > 4 && buf.slice(0, 4).toString() === '%PDF';
}

/**
 * @returns {Promise<{ buffer: Buffer, fileName: string, source: string }>}
 */
export async function downloadLonestarStatementFromPortal({
  periodEnd = null,
  accountLast4 = null,
} = {}) {
  const cfg = getLonestarPortalConfig();
  if (!cfg.enabled) {
    throw new Error(
      'Lone Star portal credentials not configured. Set LONESTAR_ONLINE_USER and LONESTAR_ONLINE_PASSWORD on Render.'
    );
  }

  await ensurePlaywrightBrowsers();
  const last4 = accountLast4 || cfg.accountLast4;
  const { chromium } = await loadPlaywright();
  const executablePath = chromium.executablePath();
  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(
      `Playwright Chromium not installed (expected under ${getPlaywrightBrowsersPath()}). Redeploy the app on Render.`
    );
  }
  const browser = await chromium.launch({
    headless: process.env.LONESTAR_PORTAL_HEADLESS !== '0',
    executablePath,
  });

  const tmpPath = path.join(os.tmpdir(), `lonestar-estatement-${Date.now()}.pdf`);

  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    const loginUrl = `${cfg.portalUrl.replace(/\/$/, '')}/login`;
    await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 90_000 });
    await page.waitForSelector('#username', { timeout: 30_000 });
    await page.locator('#username').fill(cfg.user);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#password', { timeout: 30_000 });
    await page.locator('#password').fill(cfg.password);

    const signIn = page.getByRole('button', { name: /sign in/i });
    if (await signIn.count()) {
      await signIn.first().click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 90_000 }).catch(() => {});

    if (page.url().includes('/login')) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (/two[\-\s]?factor|verification code|passkey|security code/i.test(bodyText)) {
        throw new Error(
          'Lone Star login requires 2FA or passkey — disable 2FA for the automation user or use a dedicated NetTeller ID without 2FA.'
        );
      }
      throw new Error('Lone Star portal login failed — check LONESTAR_ONLINE_USER and LONESTAR_ONLINE_PASSWORD.');
    }

    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});

    const accountLink = page.getByText(new RegExp(`${last4}|\\*{4}${last4}|x{4}${last4}`, 'i')).first();
    if (await accountLink.count()) {
      await accountLink.click();
      await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
    }

    const documentsEntry = page.getByRole('link', { name: /documents/i })
      .or(page.getByRole('button', { name: /documents/i }))
      .or(page.getByText(/^documents$/i));
    if (await documentsEntry.count()) {
      await documentsEntry.first().click();
      await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});
    } else {
      await page.goto(`${cfg.portalUrl.replace(/\/$/, '')}/documents`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
    }

    const statementsTab = page.getByRole('tab', { name: /statements/i })
      .or(page.getByText(/^statements$/i));
    if (await statementsTab.count()) {
      await statementsTab.first().click();
      await page.waitForTimeout(1500);
    }

    let download = null;
    const stmtRow = periodEnd
      ? page.getByText(new RegExp(periodEnd.replace(/-/g, '[/-]'), 'i')).first()
      : page.locator('[role="row"], jha-list-item, .document-row, li').filter({ hasText: /statement/i }).first();

    const downloadPromise = page.waitForEvent('download', { timeout: 120_000 }).catch(() => null);

    if (await stmtRow.count()) {
      await stmtRow.click();
    } else {
      const firstStatement = page.getByText(/statement/i).first();
      if (await firstStatement.count()) await firstStatement.click();
    }

    download = await downloadPromise;

    if (!download) {
      const pdfResponse = await page.waitForResponse(
        (res) => res.url().toLowerCase().includes('pdf') || res.headers()['content-type']?.includes('pdf'),
        { timeout: 30_000 }
      ).catch(() => null);
      if (pdfResponse) {
        const body = await pdfResponse.body();
        if (isPdfBuffer(body)) {
          const fileName = `LJCckg${last4}_portal_${Date.now()}.pdf`;
          return { buffer: body, fileName, source: 'portal-response' };
        }
      }
      throw new Error('Could not download Lone Star statement PDF from portal (no download event).');
    }

    await download.saveAs(tmpPath);
    const buffer = fs.readFileSync(tmpPath);
    if (!isPdfBuffer(buffer)) {
      throw new Error('Lone Star portal download was not a PDF file.');
    }

    const suggested = download.suggestedFilename() || `LJCckg${last4}_statement.pdf`;
    return { buffer, fileName: suggested, source: 'portal-download' };
  } finally {
    await browser.close().catch(() => {});
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Try fetching a direct PDF URL from the notification email body.
 */
export async function fetchLonestarPdfFromUrl(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'LJC-Accounting-Statement-Ingest/1.0',
      Accept: 'application/pdf,*/*',
    },
  });
  if (!res.ok) {
    throw new Error(`Statement URL returned HTTP ${res.status}`);
  }
  const ct = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  if (!isPdfBuffer(buf)) {
    if (!ct.includes('pdf')) {
      throw new Error('URL did not return a PDF (likely requires browser login).');
    }
  }
  const fileName = url.split('/').pop()?.split('?')[0] || 'lonestar-statement.pdf';
  return { buffer: buf, fileName, source: 'email-link' };
}
