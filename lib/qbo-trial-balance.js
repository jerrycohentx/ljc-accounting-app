/**
 * Parse QuickBooks Online trial balance CSV exports and roll up to app COA.
 */

import Decimal from 'decimal.js';

export function parseMoney(raw) {
  if (raw == null || raw === '') return new Decimal(0);
  const cleaned = String(raw).replace(/[$,"\s]/g, '');
  if (!cleaned || cleaned === '-') return new Decimal(0);
  return new Decimal(cleaned);
}

/** Parse one CSV line respecting quoted fields. */
function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      fields.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  fields.push(cur.trim());
  return fields;
}

/**
 * @returns {{ name: string, debit: Decimal, credit: Decimal, netDebit: Decimal }[]}
 */
export function parseQboTrialBalance(csvText) {
  const rows = [];
  for (const rawLine of csvText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^total/i.test(line)) break;
    if (/cash basis/i.test(line)) continue;
    if (/^full name,/i.test(line)) continue;
    if (/^trial balance/i.test(line)) continue;
    if (/^as of /i.test(line)) continue;
    if (/^"[^"]+",,$/.test(line)) continue; // entity header line

    const fields = splitCsvLine(line);
    if (fields.length < 3) continue;

    const name = fields[0].replace(/^"|"$/g, '');
    if (!name || /^[\d,.\s$]+$/.test(name)) continue;

    const debit = parseMoney(fields[1]);
    const credit = parseMoney(fields[2]);
    if (debit.isZero() && credit.isZero()) continue;

    rows.push({
      name,
      debit,
      credit,
      netDebit: debit.minus(credit),
    });
  }
  return rows;
}

/**
 * Infer QBO account category from name for rollup when no explicit mapping matches.
 */
export function inferQboCategory(name) {
  const n = name.toLowerCase();

  if (/opening bal|opening balance equity|owner'?s? (capital|equity|draw|draws)|partners equity|members equity|members? draw|partner \d draw|shareholder draw|retained earnings|additional contributions|contributions|distributions|draws:/i.test(n)) {
    return 'EQUITY';
  }
  if (/income|interest income|rental income|lending income|services|late fee|dividend received|gain \(loss\)|gain on sale|uncategorized income|misc income|finance charges|money market interest|unapplied cash payment income|yield participation|funding fees|origination fees|exit fees|prepaid interest|early lease termination|rental property income|lending income|interest earned/i.test(n)) {
    return 'REVENUE';
  }
  if (
    /expense|expenses|charges|fees|insurance|professional|legal|accounting|rent expense|repairs|utilities|telephone|travel|donation|dues|wages|payroll|advertising|marketing|management fee|supplies|maintenance|food service|referral|commission|property tax|property taxes|taxes:|bank service|miscellaneous|uncategorized expense|ask my accountant|automobile|postage|security system|merchant deposit|underwriting|inspection|wire fee|origination fee|recording fee|appraisal|notary|eviction|refinance|selling costs|short term rental expenses|digital marketing|software subscription|health insurance|computer and internet|office supplies|credit card processing|lending:|lending expenses|rental property:|rental property expenses|bank expenses|interest expense|finance charges|outside services|resident food|facility maintenance|landscaping|plumbing|disposal|electricity|fire suppression|internet & tv|phone service|security system|business licenses|payroll taxes|payroll expenses|bank fees|legal & accounting|interest expense|dues & subscriptions/i.test(n)
    && !/income|receivable|payable(?!.*expense)|escrow|holdback|deposit(?!.*fee)/i.test(n)
  ) {
    return 'EXPENSE';
  }
  if (/accounts payable|credit card|notes payable|notes payable|accrued|deferred|profit sharing|deposits:|hold backs|holdbacks|holdback|payroll liabilities|direct deposit payable|long-term loan|loans from shareholder|visa |amex|chase card|notes payable|real estate notes payable|rehab holdback|payable to|members draw - prior|gloc|wloc|dloc|lines of credit|notes payable cre|ljc aviation|4j&l partners|payroll liabilities|federal taxes|federal unemployment|tx unemployment|rental property escrows:/i.test(n)) {
    return 'LIABILITY';
  }
  return 'ASSET';
}

/**
 * @param {{ name: string, netDebit: Decimal }[]} rows
 * @param {{ pattern: RegExp, accountNumber: string }[]} mappings - first match wins
 * @param {{ accountNumber: string, category: string }[]} fallbacks - by inferred category
 */
export function accountTypeFromNumber(accountNumber) {
  const n = parseInt(accountNumber, 10);
  if (n >= 1000 && n < 2000) return 'ASSET';
  if (n >= 2000 && n < 3000) return 'LIABILITY';
  if (n >= 3000 && n < 4000) return 'EQUITY';
  if (n >= 4000 && n < 5000) return 'REVENUE';
  return 'EXPENSE';
}

export function rollupTrialBalance(rows, mappings, fallbacks) {
  const totals = {};
  const unmapped = [];

  for (const row of rows) {
    const lower = row.name.toLowerCase();
    if (/opening balance equity|opening bal equity/i.test(lower)) continue;

    let accountNumber = null;
    for (const m of mappings) {
      if (m.pattern.test(row.name) || m.pattern.test(lower)) {
        accountNumber = m.accountNumber;
        break;
      }
    }

    if (!accountNumber) {
      const cat = inferQboCategory(row.name);
      const fb = fallbacks.find((f) => f.category === cat);
      accountNumber = fb?.accountNumber || '3999';
      if (accountNumber === '3999') unmapped.push(row.name);
    }

    if (!totals[accountNumber]) totals[accountNumber] = new Decimal(0);
    totals[accountNumber] = totals[accountNumber].plus(row.netDebit);
  }

  const balances = Object.entries(totals)
    .map(([accountNumber, netDebit]) => {
      const type = accountTypeFromNumber(accountNumber);
      const isCreditNormal = ['LIABILITY', 'EQUITY', 'REVENUE'].includes(type);
      const balance = isCreditNormal ? netDebit.negated().toFixed(2) : netDebit.toFixed(2);
      return { accountNumber, balance: Number(balance) };
    })
    .filter((b) => Math.abs(b.balance) > 0.004);

  return { balances, unmapped };
}

export function verifySourceBalance(rows) {
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const row of rows) {
    debit = debit.plus(row.debit);
    credit = credit.plus(row.credit);
  }
  return {
    totalDebit: debit.toFixed(2),
    totalCredit: credit.toFixed(2),
    balanced: debit.equals(credit),
  };
}
