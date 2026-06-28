#!/usr/bin/env node
/** Render startup — ensure Chromium exists before accepting traffic. */
import { ensurePlaywrightBrowsers } from '../lib/playwright-browsers.js';

try {
  await ensurePlaywrightBrowsers();
} catch (err) {
  console.warn('Playwright Chromium install skipped/failed (Lone Star portal download unavailable):', err.message);
}
