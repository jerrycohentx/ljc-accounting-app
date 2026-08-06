import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/** Per-entity statement JSON bundles. Never map sister-entity 1000 → LJC Simmons. */
const JSON_BY_ENTITY_ACCOUNT = {
  'ent-ljc': {
    '1000': 'data/bank-imports/LJC/simmons-2026-statements.json',
    '1001': 'data/bank-imports/LJC/lonestar-2026-statements.json',
    '1002': 'data/bank-imports/LJC/csb-2026-statements.json',
    '2010': 'data/bank-imports/LJC/amex-2026-statements.json',
  },
  'ent-omc': {
    '1000': 'data/bank-imports/OMC/simmons-7036-2026-statements.json',
    '2011': 'data/bank-imports/OMC/chase-6508-2026-statements.json',
  },
};

export function jsonPathForAccount(accountNumber, entityId = 'ent-ljc') {
  const byEntity = JSON_BY_ENTITY_ACCOUNT[entityId || 'ent-ljc'];
  if (!byEntity) return null;
  return byEntity[String(accountNumber)] || null;
}

export function mergeStatementJson(accountNumber, parsedStatement, entityId = 'ent-ljc') {
  const rel = jsonPathForAccount(accountNumber, entityId);
  if (!rel) {
    throw new Error(
      `No statement JSON bundle for ${entityId || 'ent-ljc'} account ${accountNumber}`
    );
  }

  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });

  let doc = {
    generatedAt: new Date().toISOString(),
    entityId: entityId || 'ent-ljc',
    statements: [],
  };
  if (fs.existsSync(full)) {
    doc = JSON.parse(fs.readFileSync(full, 'utf8'));
  }

  const periodEnd = parsedStatement.meta?.periodEnd;
  doc.entityId = entityId || doc.entityId || 'ent-ljc';
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
