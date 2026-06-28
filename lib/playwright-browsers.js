/**
 * Playwright browser path for Render — default cache (~/.cache) is not kept at runtime.
 * Install browsers into the project directory so build + runtime share the same path.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let ensurePromise = null;

export function getPlaywrightBrowsersPath() {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const browsersPath = configured || path.join(ROOT, '.playwright-browsers');
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  return browsersPath;
}

function browsersInstalled(browsersPath) {
  if (!fs.existsSync(browsersPath)) return false;
  const stack = [browsersPath];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (/^chrome(-headless-shell)?$/i.test(entry.name)) return true;
    }
  }
  return false;
}

/** Install Chromium into project dir if missing (Render cold start fallback). */
export async function ensurePlaywrightBrowsers() {
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const browsersPath = getPlaywrightBrowsersPath();
    if (browsersInstalled(browsersPath)) return browsersPath;

    fs.mkdirSync(browsersPath, { recursive: true });
    console.log(`Installing Playwright Chromium → ${browsersPath}`);
    await execFileAsync(
      'npx',
      ['playwright', 'install', 'chromium'],
      {
        cwd: ROOT,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
        maxBuffer: 20 * 1024 * 1024,
      }
    );
    if (!browsersInstalled(browsersPath)) {
      throw new Error(`Playwright Chromium install finished but binary not found in ${browsersPath}`);
    }
    console.log('✓ Playwright Chromium ready');
    return browsersPath;
  })().catch((err) => {
    ensurePromise = null;
    throw err;
  });

  return ensurePromise;
}
