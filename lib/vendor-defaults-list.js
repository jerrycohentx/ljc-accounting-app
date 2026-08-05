/**
 * Build vendor default category list — real merchants from card/bank statements only.
 * Excludes bank memos (DDA, interest, draws, transfers). Does not surface orphan saved rules.
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

/** Bank/card memo patterns — not merchants for default-category review. */
const NON_VENDOR_RE = [
  /\bDDA\b.*\bMEMO\b/i,
  /\bDEBIT\s+MEMO\b/i,
  /\bCREDIT\s+MEMO\b/i,
  /\bINTEREST\s+PAID\b/i,
  /\bINTEREST\s+CHARG/i,
  /\bDRAW\s*#?\b/i,
  /\bDEPOSIT\b/i,
  /\bWIRE\s+TRANSFER\b/i,
  /\bTRANSFER\s+X\d/i,
  /\bAUTOPAY\b/i,
  /\bAUTOMATIC\s+PAYMENT\b/i,
  /\bEPAY\s+CHASE\b/i,
  /\bFAY\s+SERVICING\b/i,
  /\bNEWREZ\b/i,
  /\bSHELLPOINT\b/i,
  /\bACH\s+BATCH\b/i,
  /\bGRACEFUL\s+ME/i,
  /\bINTPAY\b/i,
  /\bACCOUNT\s+ANALYSIS\b/i,
  /\bPHONE\/IN-PERSON\s+TRANSFER\b/i,
  /\bFEB\s+PYMNT\b/i,
  /\bLEANNE\b.*\bLJC\b/i,
  /\bRENT\s+INCOME\b/i,
  /\bOWNER'?S?\s+DRAW\b/i,
  /\bHOLDBACK\b/i,
  /\bLOC\b.*\bADVANCE\b/i,
  /\bLOC\b.*\bPAYDOWN\b/i,
  /\bMOBILE\s+DEPOSIT\b/i,
  /\bPAYMENT\s+THANK\s+YOU\b/i,
  /^TRANSFER\b/i,
  /^DEPOSIT\b/i,
  /^WIRE\b/i,
];

export function isNonVendorDescription(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 4) return true;
  return NON_VENDOR_RE.some((re) => re.test(t));
}

export function isRealMerchantPattern(pattern, description) {
  const p = String(pattern || '').trim();
  if (!p || p.length < 3) return false;
  if (isNonVendorDescription(description || p)) return false;
  if (/^(TRANSFER|DEPOSIT|WIRE|DRAW|DDA|INTPAY|INTEREST|AUTOPAY|EPAY|ACH|FAY|GRACEFUL|LEANNE|FEB)$/i.test(p)) {
    return false;
  }
  return true;
}

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
  if (/statement|6508|5068|88007|ckg|amex/i.test(base)) score += 3;
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
export function parseChaseCcVendorsFromText(text, { last4 } = {}) {
  const vendors = [];
  const cardHint = last4 ? String(last4) : '6508';
  if (
    !new RegExp(`XXXX XXXX XXXX ${cardHint}|Account Number.*${cardHint}|CHASE\\.COM`, 'i').test(text)
    && !/ACCOUNT ACTIVITY/i.test(text)
  ) {
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
    if (isNonVendorDescription(desc)) continue;
    vendors.push({
      description: desc.replace(/\s+/g, ' '),
      amount: Math.abs(amt),
      source: 'chase-statement',
    });
  }
  return vendors;
}

function loadStatementSeed(entityId, month, accountScope) {
  if (accountScope !== 'cc') return null;
  const rel = path.join('data', 'vendor-statement-seeds', entityId, `${month}-chase-cc.json`);
  const candidates = [path.join(process.cwd(), rel), path.join(process.cwd(), '..', rel)];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { path: p, ...raw };
    } catch {
      /* try next */
    }
  }
  return null;
}

function seedToRawVendors(seed) {
  if (!seed?.vendors?.length) return [];
  return seed.vendors.map((v) => ({
    pattern: v.pattern,
    displayName: v.sampleDescription || v.pattern,
    description: v.sampleDescription || v.pattern,
    amount: v.totalAmount,
    transactionCount: v.transactionCount,
    source: 'chase-statement-seed',
  }));
}

async function loadStatementVendors(pdfPath, { kind = 'cc', last4 } = {}) {
  if (!pdfPath) return { path: null, vendors: [], parseNote: null };
  try {
    const buf = await readPdfBufferFromPath(pdfPath);
    if (!buf) return { path: pdfPath, vendors: [], parseNote: 'could not read PDF bytes' };
    const text = await parsePdfBuffer(buf);
    let vendors = [];
    if (kind === 'cc') {
      vendors = parseChaseCcVendorsFromText(text, { last4 });
    } else if (kind === 'bank') {
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
      vendors = (parsed?.transactions || [])
        .map((t) => ({
          description: t.description,
          amount: Math.abs(t.amount),
          source: 'bank-statement',
        }))
        .filter((v) => !isNonVendorDescription(v.description));
    }
    return {
      path: pdfPath,
      vendors,
      parseNote: vendors.length ? null : 'statement found; merchant lines not extracted',
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

    const desc = [header.description, header.memo].filter(Boolean).join(' ');
    if (isNonVendorDescription(desc)) continue;

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

    const pattern = deriveVendorPattern(desc);
    if (!isRealMerchantPattern(pattern, desc)) continue;

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
    if (!isRealMerchantPattern(key, v.description || v.displayName)) continue;
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
    cur.transactionCount += Number(v.transactionCount || 1);
    cur.totalAmount += Number(v.amount || v.totalAmount || 0);
    if ((v.description || v.sampleDescription || '').length > (cur.sampleDescription || '').length) {
      cur.sampleDescription = v.description || v.sampleDescription || cur.sampleDescription;
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
    if (!key || !byPattern.has(key)) continue;
    const cur = byPattern.get(key);
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

export async function buildVendorDefaultsList(
  db,
  { entityId, month = '2026-01', accountScope: accountScopeIn } = {}
) {
  if (!entityId) throw new Error('entityId required');
  const { start, end } = monthBounds(month);
  const cfg = ENTITY_ACCOUNTS[entityId] || { bank: { numbers: ['1000'], hints: [] }, cc: null };

  let accountScope = accountScopeIn;
  if (!accountScope || accountScope === 'auto') {
    accountScope = cfg.cc ? 'cc' : 'bank';
  }

  const rules = await listVendorCategoryRules(db, { entityId });
  const bookAccountNumbers =
    accountScope === 'cc'
      ? [...(cfg.cc?.numbers || [])]
      : accountScope === 'bank'
        ? [...(cfg.bank?.numbers || ['1000'])]
        : [...(cfg.bank?.numbers || ['1000']), ...(cfg.cc?.numbers || [])];

  const bookVendors = bookAccountNumbers.length
    ? await collectBookVendors(db, entityId, start, end, bookAccountNumbers)
    : [];

  const statementHits = [];
  if (accountScope === 'bank' || accountScope === 'all') {
    if (cfg.bank) {
      statementHits.push(
        ...discoverStatementPdfPaths({ hints: cfg.bank.hints, month, last4: cfg.bank.last4 })
      );
    }
  }
  if (accountScope === 'cc' || accountScope === 'all') {
    if (cfg.cc) {
      statementHits.push(
        ...discoverStatementPdfPaths({ hints: cfg.cc.hints, month, last4: cfg.cc.last4 })
      );
    }
  }

  const seenPaths = new Set();
  const stmtResults = [];
  const monthMatched = statementHits
    .filter((h) => statementMatchesMonth(h.path, month))
    .sort((a, b) => b.score - a.score);
  const stmtQueue = [...monthMatched, ...statementHits.sort((a, b) => b.score - a.score)];

  for (const hit of stmtQueue) {
    if (seenPaths.has(hit.path)) continue;
    const isCcPath = /6508|5068|88007|chase|amex|statements-/i.test(hit.path);
    const isBankPath = /ckg|checking|7036|0260|7292|5718/i.test(hit.path) && !isCcPath;
    if (accountScope === 'cc' && !isCcPath) continue;
    if (accountScope === 'bank' && !isBankPath) continue;
    seenPaths.add(hit.path);
    stmtResults.push(
      await loadStatementVendors(hit.path, { kind: isCcPath ? 'cc' : 'bank', last4: cfg.cc?.last4 })
    );
    if (stmtResults.length >= (accountScope === 'all' ? 2 : 1)) break;
  }

  const seed = loadStatementSeed(entityId, month, accountScope);

  const stmtVendors = [];
  for (const sr of stmtResults) {
    for (const v of sr.vendors || []) {
      const pattern = v.pattern || deriveVendorPattern(v.description);
      if (!isRealMerchantPattern(pattern, v.description)) continue;
      stmtVendors.push({
        pattern,
        displayName: v.description,
        description: v.description,
        amount: v.amount,
        transactionCount: v.transactionCount || 1,
        source: v.source || 'chase-statement',
      });
    }
  }

  const vendors = mergeVendorRows(
    [...(stmtVendors.length ? stmtVendors : seedToRawVendors(seed)), ...bookVendors],
    rules
  );

  const scopeLabel =
    accountScope === 'cc'
      ? `Chase card …${cfg.cc?.last4 || 'CC'} merchants`
      : accountScope === 'bank'
        ? 'Bank checking merchants'
        : 'Bank + card merchants';

  return {
    entityId,
    month,
    accountScope,
    scopeLabel,
    periodStart: start,
    periodEnd: end,
    statementPaths: stmtResults.map((s) => ({
      path: s.path,
      parseNote: s.parseNote,
      vendorCount: (s.vendors || []).length,
    })),
    statementSeed: seed ? { path: seed.path, vendorCount: seed.vendors?.length || 0 } : null,
    searchRoots: SEARCH_DIRS.filter((d) => fs.existsSync(d)),
    vendorCount: vendors.length,
    vendors,
    learningNote:
      'Merchants from the card statement only (no bank memos, transfers, or interest). Saving a default creates a durable vendor rule.',
  };
}

export async function saveVendorDefaults(db, { entityId, vendors = [] } = {}) {
  const saved = [];
  for (const row of vendors) {
    if (!row?.accountId || !row?.pattern) continue;
    if (!isRealMerchantPattern(row.pattern, row.sampleDescription || row.pattern)) continue;
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
