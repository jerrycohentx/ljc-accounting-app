import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let cached = null;

function readPkgVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readGitSha() {
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref:')) {
      const ref = head.slice(4).trim();
      return fs.readFileSync(path.join(ROOT, '.git', ref), 'utf8').trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return process.env.RENDER_GIT_COMMIT?.slice(0, 7) || null;
  }
}

export function getAppInfo() {
  if (cached) return cached;
  const version = process.env.APP_VERSION || readPkgVersion();
  const gitSha = readGitSha();
  cached = {
    name: 'LJC AI Accounting',
    version,
    gitSha,
    buildLabel: gitSha ? `v${version} (${gitSha})` : `v${version}`,
    nodeEnv: process.env.NODE_ENV || 'development',
    startedAt: new Date().toISOString(),
  };
  return cached;
}
