/**
 * Build vendor default category list for an entity/month — Chase CC + bank activity.
 * Merges statement PDF vendors (when parseable), posted books, and saved rules.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  deriveVendorPattern,
  listVendorCategoryRules,
  upsertVendorCategoryRule,
} from './vendor-category-rule.js';
import { resolveEffectiveFromAccount } from './journal-reclass-history.js';
import { extractPdfStatementFromFile } from './extract-pdf-statement.js';
import { parsePdfBuffer } from './pdf-parse-compat.js';
import { learnFromUserCategory } from './category-learn.js';

/** Entity monitored cash / card accounts for vendor defaults. */
export const ENTITY_ACCOUNTS = {
  'ent-omc': {
    bank: { numbers: ['1000'], last4: '7036', hints: ['7036', 'omc ckg', 'comm chk'] },
    cc: { numbers: ['2011'], last4: '6508', hints: ['6508', 'chase', 'omc cc'] },
  },
  'ent-ljc': {
    bank: { numbers: ['1000', '1001'], last4: '0260', hints: ['0260', '7367', 'ljc ckg'] },
    cc: { numbers: ['2010'], last4: '88007', hints: ['amex', '88007'] },
  },
  'ent-gm': {
    bank: { numbers: ['1000'], last4: '7292', hints: ['7292', 'wells'] },
    cc: { numbers: ['2011'], last4: '5068', hints: ['5068', 'chase'] },
  },
  'ent-justin': {
    bank: { numbers: ['1000'], last4: null, hints: ['justin', 'simmons'] },
    cc: null,
  },
  'ent-4jl': {
    bank: { numbers: ['1000'], last4: '5718', hints: ['5718', '4jl'] },
    cc: null,
  },
  'ent-qof': {
    bank: { numbers: ['1000'], last4: null, hints: ['qof'] },
    cc: null,
  },
};

const SEARCH_DIRS = [
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Downloads'),
  process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'OneDrive', 'Desktop', 'Downloads-Jerry OneDrive'),
  'C:\\Users\\jerry\\Downloads',
  'C:\\Users\\jerry\\OneDrive\\Desktop\\Downloads-Jerry OneDrive',
].filter(Boolean);

function statementMatchesMonth(filePath, month) {
  const [y, m] = String(month || '').split('-');
  if (!y || !m) return false;
  const base = String(filePath).toLowerCase();
  if (base.includes(`${y}${m}`) || base.includes(`${y}-${m}`)) return true;
  if (new RegExp(`statement-0?${parseInt(m, 10)}-`, 'i').test(base) && base.includes(y)) return true;
  if (new RegExp(`statement-${m.padStart(2, '0')}-\\d{2}-${y}`, 'i').test(base)) return true;
  return false;
}

function monthBounds(ym) {
  const [y, m] = String(ym).split('-').map((x) => parseInt(x, 10));
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

function isBankishLine(line, bankNumbers) {
  const num = String(line.account_number || '');
  if (bankNumbers.includes(num)) return true;
  const typ = String(line.account_type || '').toUpperCase();
  if (/^10\d{2}/.test(num) && typ === 'ASSET') return true;
  if (/^20\d{2}/.test(num) && typ === 'LIABILITY') return true;
  return false;
}

function scoreName(name, { hintL, last4, month }) {
  const base = String(name).toLowerCase();
  let score = 0;
  for (const h of hintL) {
    if (base.includes(h)) score += 10;
  }
  if (last4 && base.includes(String(last4))) score += 15;
  const y = String(month || '').slice(0, 4);
  const m = String(month || '').slice(5, 7);
  if (y && base.includes(y)) score += 5;
  if (m && (base.includes(`${y}${m}`) || base.includes(`${m}-${y}`) || base.includes(`-${m}-`))) score += 8;
  if (month && statementMatchesMonth(name, month)) score += 20;
  if (/statement|6508|ckg|amex/i.test(base)) score += 3;
  return score;
}

function runPythonScript(script, args = [], opts = {}) {
  try {
    const argStr = args.map((a) => `"${String(a).replace(/"/g, '')}"`).join(' ');
    const execOpts = {
      timeout: opts.timeout || 15000,
      maxBuffer: opts.maxBuffer || 20 * 1024 * 1024,
      stdio: opts.binary ? ['pipe', 'pipe', 'ignore'] : ['pipe', 'pipe', 'ignore'],
    };
    if (!opts.binary) execOpts.encoding = 'utf8';
    return execSync(`python -c "${script.replace(/"/g, '\\"')}" ${argStr}`, execOpts);
  } catch {
    return null;
  }
}

function isZipFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4b;
  } catch {
    return false;
  }
}

function listZipPdfMembers(zipPath) {
  const script =
    'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([n for n in z.namelist() if n.lower().endswith(".pdf")]))';
  const out = runPythonScript(script, [zipPath]);
  if (!out) return [];
  try {
    return JSON.parse(String(out).trim() || '[]');
  } catch {
    return [];
  }
}

/** Scan Downloads roots including zip members (fixes OMC CC.zip miss). */
export function discoverStatementPdfPaths({ hints = [], month, last4 } = {}) {
  const found = [];
  const hintL = hints.map((h) => String(h).toLowerCase());

  for (const dir of SEARCH_DIRS) {
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && /\.pdf$/i.test(ent.name)) {
        const score = scoreName(ent.name, { hintL, last4, month });
        if (score >= 10) found.push({ path: full, score, source: 'file' });
      }
      if (ent.isFile() && /\.zip$/i.test(ent.name)) {
        if (!isZipFile(full)) continue;
        for (const member of listZipPdfMembers(full)) {
          const score =
            scoreName(member, { hintL, last4, month }) + scoreName(ent.name, { hintL, last4, month });
          if (score >= 12) {
            found.push({
              path: `${full}!${member}`,
              score,
              source: 'zip-member',
            });
          }
        }
      }
    }
  }

  found.sort((a, b) => b.score - a.score);
  return found;
}

async function readPdfBufferFromPath(pdfPath) {
  if (pdfPath.includes('!')) {
    const [zipPath, member] = pdfPath.split('!');
    const script =
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); sys.stdout.buffer.write(z.read(sys.argv[2]))';
    const buf = runPythonScript(script, [zipPath, member], { binary: true, timeout: 30000 });
    return buf || null;
  }
  if (!fs.existsSync(pdfPath)) return null;
  return fs.readFileSync(pdfPath);
}

/** Parse Chase CC purchase lines from statement text (best effort). */
export function parseChaseCcVendorsFromText(text) {
  const vendors = [];
  if (!/XXXX XXXX XXXX 6508|CHASE CARD|CHASE\.COM|Account Number.*6508/i.test(text)) {
    return vendors;
  }

  const activityIdx = text.indexOf('ACCOUNT ACTIVITY');
  const slice = activityIdx >= 0 ? text.slice(activityIdx) : text;
  const lineRe = /^(\d{2}\/\d{2})\s+(.+)$/gm;
  let m;
  while ((m = lineRe.exec(slice)) !== null) {
    const tail = m[2].trim();
    const amtMatch = tail.match(/(-?\d[\d,]*\.\d{2})\s*$/);
    if (!amtMatch) continue;
    const amt = parseFloat(amtMatch[1].replace(/,/g, ''));
    const desc = tail.slice(0, tail.length - amtMatch[0].length).replace(/\s+[A-Z]{2}\s*$/, '').trim();
    if (!desc || desc.length < 4) continue;
    if (/payment|credit|interest|fee|total|balance|autopay|thank you/i.test(desc)) continue;
    vendors.push({
      description: desc.replace(/\s+/g, ' '),
      amount: Math.abs(amt),
      source: 'chase-statement',
    });
  }
  return vendors;
}

async function loadStatementVendors(pdfPath) {
  if (!pdfPath) return { path: null, vendors: [], parseNote: null };
  try {
    const buf = await readPdfBufferFromPath(pdfPath);
    if (!buf) return { path: pdfPath, vendors: [], parseNote: 'could not read PDF bytes' };
    const text = await parsePdfBuffer(buf);
    let parsed = null;
    try {
      const tmp = path.join(process.cwd(), `_tmp_stmt_${Date.now()}.pdf`);
      fs.writeFileSync(tmp, buf);
      parsed = await extractPdfStatementFromFile(tmp);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    } catch {
      parsed = null;
    }
    const fromChecking = (parsed?.transactions || []).map((t) => ({
      description: t.description,
      amount: Math.abs(t.amount),
      source: 'bank-statement',
    }));
    const fromChase = parseChaseCcVendorsFromText(text);
    const vendors = [...fromChecking, ...fromChase];
    return {
      path: pdfPath,
      vendors,
      parseNote: vendors.length ? null : 'statement found; line detail not extracted — using books',
    };
  } catch (e) {
    return { path: pdfPath, vendors: [], parseNote: e.message };
  }
}

async function collectBookVendors(db, entityId, start, end, bankNumbers) {
  const rows = await db.all(
    `SELECT je.id AS journal_id, je.je_number, je.description, je.memo, je.posting_date,
            jel.id AS line_id, jel.debit, jel.credit,
            a.id AS account_id, a.account_number, a.account_name, a.account_type
     FROM journal_entries je
     JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
     JOIN accounts a ON a.id = jel.account_id
     WHERE je.entity_id = ?
       AND je.status = 'POSTED'
       AND je.reversed_by_je_id IS NULL
       AND je.reverses_je_id IS NULL
       AND date(je.posting_date) >= date(?)
       AND date(je.posting_date) <= date(?)
     ORDER BY je.posting_date, je.je_number, jel.line_number`,
    [entityId, start, end]
  );

  const byJe = new Map();
  for (const r of rows) {
    if (!byJe.has(r.journal_id)) byJe.set(r.journal_id, { header: r, lines: [] });
    byJe.get(r.journal_id).lines.push(r);
  }

  const vendors = [];
  for (const { header, lines } of byJe.values()) {
    const bankLine = lines.find((l) => isBankishLine(l, bankNumbers));
    if (!bankLine) continue;
    const bankAmt = Math.abs(Number(bankLine.debit || 0) - Number(bankLine.credit || 0));
    if (bankAmt < 0.005) continue;

    const offsetLines = lines.filter((l) => !isBankishLine(l, bankNumbers));
    const prefer = offsetLines.filter((l) =>
      /EXPENSE|INCOME|COST OF GOODS/i.test(String(l.account_type || ''))
    );
    const pool = (prefer.length ? prefer : offsetLines)
      .slice()
      .sort(
        (a, b) =>
          Math.abs(Number(b.debit || 0) - Number(b.credit || 0))
          - Math.abs(Number(a.debit || 0) - Number(a.credit || 0))
      );
    const off = pool[0];
    if (!off) continue;

    const desc = [header.description, header.memo].filter(Boolean).join(' ');
    const pattern = deriveVendorPattern(desc);
    if (!pattern) continue;

    let effective = {
      accountId: off.account_id,
      accountNumber: off.account_number,
      accountName: off.account_name,
    };
    try {
      const eff = await resolveEffectiveFromAccount(db, {
        entityId,
        journalId: header.journal_id,
        lineId: off.line_id,
        originalAccountId: off.account_id,
        originalAccountNumber: off.account_number,
      });
      if (eff?.fromAccountId) {
        effective = {
          accountId: eff.fromAccountId,
          accountNumber: eff.fromAccountNumber,
          accountName: eff.fromAccountName,
        };
      }
    } catch {
      /* use line account */
    }

    vendors.push({
      pattern,
      displayName: desc.slice(0, 80),
      description: desc,
      amount: bankAmt,
      source: 'books',
      currentAccountId: effective.accountId,
      currentAccountNumber: effective.accountNumber,
      currentAccountName: effective.accountName,
    });
  }
  return vendors;
}

function mergeVendorRows(rawVendors, rules) {
  const byPattern = new Map();

  for (const v of rawVendors) {
    const key = String(v.pattern || '').toUpperCase();
    if (!key || key.length < 3) continue;
    const cur = byPattern.get(key) || {
      pattern: key,
      displayName: v.displayName || v.description || key,
      sources: new Set(),
      transactionCount: 0,
      totalAmount: 0,
      sampleDescription: v.description || v.displayName || key,
      currentAccountId: null,
      currentAccountNumber: null,
      currentAccountName: null,
      ruleId: null,
      hasRule: false,
    };
    cur.sources.add(v.source || 'unknown');
    cur.transactionCount += 1;
    cur.totalAmount += Number(v.amount || 0);
    if ((v.description || '').length > (cur.sampleDescription || '').length) {
      cur.sampleDescription = v.description;
    }
    if (v.currentAccountId) {
      cur.currentAccountId = v.currentAccountId;
      cur.currentAccountNumber = v.currentAccountNumber;
      cur.currentAccountName = v.currentAccountName;
    }
    byPattern.set(key, cur);
  }

  for (const rule of rules || []) {
    const key = String(rule.pattern || '').toUpperCase();
    if (!key) continue;
    const cur = byPattern.get(key) || {
      pattern: key,
      displayName: rule.label || key,
      sources: new Set(['rule-only']),
      transactionCount: 0,
      totalAmount: 0,
      sampleDescription: rule.label || key,
      currentAccountId: null,
      currentAccountNumber: null,
      currentAccountName: null,
    };
    cur.ruleId = rule.id;
    cur.hasRule = true;
    cur.defaultAccountId = rule.accountId;
    cur.defaultAccountNumber = rule.accountNumber;
    cur.defaultAccountName = rule.accountName;
    if (!cur.currentAccountId && rule.accountId) {
      cur.currentAccountId = rule.accountId;
      cur.currentAccountNumber = rule.accountNumber;
      cur.currentAccountName = rule.accountName;
    }
    byPattern.set(key, cur);
  }

  return [...byPattern.values()]
    .map((v) => ({
      pattern: v.pattern,
      displayName: v.displayName,
      sources: [...v.sources],
      transactionCount: v.transactionCount,
      totalAmount: Math.round(v.totalAmount * 100) / 100,
      sampleDescription: v.sampleDescription,
      defaultAccountId: v.defaultAccountId || v.currentAccountId || null,
      defaultAccountNumber: v.defaultAccountNumber || v.currentAccountNumber || null,
      defaultAccountName: v.defaultAccountName || v.currentAccountName || null,
      ruleId: v.ruleId || null,
      hasRule: Boolean(v.hasRule),
    }))
    .sort((a, b) => b.totalAmount - a.totalAmount || a.pattern.localeCompare(b.pattern));
}

export async function buildVendorDefaultsList(db, { entityId, month = '2026-01' } = {}) {
  if (!entityId) throw new Error('entityId required');
  const { start, end } = monthBounds(month);
  const cfg = ENTITY_ACCOUNTS[entityId] || { bank: { numbers: ['1000'], hints: [] }, cc: null };

  const rules = await listVendorCategoryRules(db, { entityId });
  const bankNumbers = [...(cfg.bank?.numbers || ['1000']), ...(cfg.cc?.numbers || [])];

  const bookVendors = await collectBookVendors(db, entityId, start, end, bankNumbers);

  const statementHits = [];
  if (cfg.bank) {
    statementHits.push(
      ...discoverStatementPdfPaths({
        hints: cfg.bank.hints,
        month,
        last4: cfg.bank.last4,
      }).slice(0, 3)
    );
  }
  if (cfg.cc) {
    statementHits.push(
      ...discoverStatementPdfPaths({
        hints: cfg.cc.hints,
        month,
        last4: cfg.cc.last4,
      }).slice(0, 3)
    );
  }

  const seenPaths = new Set();
  const stmtResults = [];
  const monthMatched = statementHits
    .filter((h) => statementMatchesMonth(h.path, month))
    .sort((a, b) => b.score - a.score);
  const stmtQueue = [...monthMatched, ...statementHits.sort((a, b) => b.score - a.score)];
  for (const hit of stmtQueue) {
    if (seenPaths.has(hit.path)) continue;
    seenPaths.add(hit.path);
    stmtResults.push(await loadStatementVendors(hit.path));
    if (stmtResults.length >= 2) break;
  }

  const stmtVendors = [];
  for (const sr of stmtResults) {
    for (const v of sr.vendors || []) {
      const pattern = deriveVendorPattern(v.description);
      if (!pattern) continue;
      stmtVendors.push({
        pattern,
        displayName: v.description,
        description: v.description,
        amount: v.amount,
        source: v.source,
      });
    }
  }

  const vendors = mergeVendorRows([...bookVendors, ...stmtVendors], rules);

  return {
    entityId,
    month,
    periodStart: start,
    periodEnd: end,
    statementPaths: stmtResults.map((s) => ({
      path: s.path,
      parseNote: s.parseNote,
      vendorCount: (s.vendors || []).length,
    })),
    searchRoots: SEARCH_DIRS.filter((d) => fs.existsSync(d)),
    vendorCount: vendors.length,
    vendors,
    learningNote:
      'Saving a default creates a durable vendor rule for future imports. Fix category on one transaction in Reconcile still works for one-offs.',
  };
}

export async function saveVendorDefaults(db, { entityId, vendors = [] } = {}) {
  const saved = [];
  for (const row of vendors) {
    if (!row?.accountId || !row?.pattern) continue;
    const rule = await upsertVendorCategoryRule(db, {
      entityId,
      pattern: row.pattern,
      accountId: row.accountId,
      label: row.label || `Vendor: ${String(row.pattern).slice(0, 28)}`,
      description: row.sampleDescription || row.pattern,
      matchType: row.matchType || 'contains',
      priority: 4,
    });
    if (row.sampleDescription) {
      try {
        await learnFromUserCategory(db, {
          entityId,
          description: row.sampleDescription,
          offsetAccountId: row.accountId,
        });
      } catch {
        /* rule already saved */
      }
    }
    saved.push(rule);
  }
  return { savedCount: saved.length, rules: saved };
}
