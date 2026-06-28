import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const JSON_BY_ACCOUNT = {
  '1000': 'data/bank-imports/LJC/simmons-2026-statements.json',
  '1001': 'data/bank-imports/LJC/lonestar-2026-statements.json',
  '2010': 'data/bank-imports/LJC/amex-2026-statements.json',
};

export function jsonPathForAccount(accountNumber) {
  return JSON_BY_ACCOUNT[accountNumber] || null;
}

export function mergeStatementJson(accountNumber, parsedStatement) {
  const rel = jsonPathForAccount(accountNumber);
  if (!rel) throw new Error(`No statement JSON bundle for account ${accountNumber}`);

  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });

  let doc = { generatedAt: new Date().toISOString(), statements: [] };
  if (fs.existsSync(full)) {
    doc = JSON.parse(fs.readFileSync(full, 'utf8'));
  }

  const periodEnd = parsedStatement.meta?.periodEnd;
  doc.statements = (doc.statements || []).filter(
    (s) => (s.meta?.periodEnd || s.meta?.closingDate) !== periodEnd
  );
  doc.statements.push(parsedStatement);
  doc.statements.sort((a, b) => (
    String(a.meta?.periodStart || '').localeCompare(String(b.meta?.periodStart || ''))
  ));
  doc.generatedAt = new Date().toISOString();
  fs.writeFileSync(full, JSON.stringify(doc, null, 2));
  return { path: rel, statementCount: doc.statements.length, periodEnd };
}
