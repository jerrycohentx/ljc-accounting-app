/**
 * ezCheckPrinting (Halfpricesoft) CSV helpers.
 *
 * Import path in the desktop app:
 *   Import/Export → Import Checks → map columns (save map once) → Print
 *
 * Required mapped fields: Payee, Amount
 * Optional: CheckNo, CheckDate, Memo, Address1–Address4
 */

/** Suggested default company DB for LJC Simmons operating cash. */
export const EZCHECK_DEFAULT_COMPANY = 'LJC at Simmons.mdb';

export const EZCHECK_EXE =
  'C:\\Program Files (x86)\\Halfpricesoft\\ezCheckPrinting\\ezCheckPrinting.exe';

export const EZCHECK_DB_DIR =
  'C:\\Users\\Public\\Documents\\Halfpricesoft\\ezCheckPrinting';

/**
 * Header names aligned with ezCheckPrinting Import Checks field labels
 * so "First Line Header" can match dropdowns (Payee Name, Amount, …).
 */
export const EZCHECK_CSV_HEADERS = [
  'Payee Name',
  'Amount',
  'Check Date',
  'Check Number',
  'Memo',
  'Address1',
  'Address2',
  'Address3',
  'Address4',
];

function csvCell(value) {
  // ASCII-safe for ezCheckPrinting parsers (avoid em-dash / ellipsis mojibake)
  const s = value == null
    ? ''
    : String(value)
      .replace(/[\u2012-\u2015]/g, '-')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2026/g, '...')
      .replace(/\u00A0/g, ' ');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {Array<{
 *   payee: string,
 *   amount: number|string,
 *   checkDate?: string,
 *   checkNo?: string|number,
 *   memo?: string,
 *   address1?: string,
 *   address2?: string,
 *   address3?: string,
 *   address4?: string,
 * }>} rows
 */
export function buildEzCheckCsv(rows) {
  const lines = [EZCHECK_CSV_HEADERS.join(',')];
  for (const r of rows || []) {
    const amt = Number(r.amount);
    if (!r.payee || !(amt > 0)) continue;
    // ezCheckPrinting accepts MM/DD/YYYY; keep ISO if already YYYY-MM-DD → convert
    let checkDate = r.checkDate || '';
    if (/^\d{4}-\d{2}-\d{2}/.test(checkDate)) {
      const [y, m, d] = checkDate.slice(0, 10).split('-');
      checkDate = `${Number(m)}/${Number(d)}/${y}`;
    }
    lines.push(
      [
        csvCell(r.payee),
        csvCell(amt.toFixed(2)),
        csvCell(checkDate),
        csvCell(r.checkNo ?? ''),
        csvCell(r.memo ?? ''),
        csvCell(r.address1 ?? ''),
        csvCell(r.address2 ?? ''),
        csvCell(r.address3 ?? ''),
        csvCell(r.address4 ?? ''),
      ].join(',')
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function downloadEzCheckCsv(filename, csvText) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `ezcheck-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Fixed download name the local Print_ezCheck.ps1 helper looks for. */
export const EZCHECK_PRINT_NOW_FILENAME = 'ezcheck-print-now.csv';

/**
 * Download CSV for MICR printing, then hand off to the local ezCheckPrinting helper
 * via the ljc-ezcheck:// protocol (installed by Install_ezCheck_Print_Protocol.ps1).
 * The cloud app cannot drive the check printer directly.
 */
export function printCheckViaEzCheck(csvText, { openHelper = true } = {}) {
  downloadEzCheckCsv(EZCHECK_PRINT_NOW_FILENAME, csvText);
  if (!openHelper) return;
  // Give the browser a moment to start the download, then open the local helper.
  window.setTimeout(() => {
    try {
      window.location.href = 'ljc-ezcheck://print';
    } catch {
      /* protocol may not be installed yet */
    }
  }, 600);
}

/** Guess ezCheck company file from bank account label / number. */
export function suggestEzCheckCompany(account) {
  const n = String(account?.account_number || account?.number || '');
  const name = String(account?.account_name || account?.name || '').toLowerCase();
  if (n === '1000' || /simmons/.test(name)) return 'LJC at Simmons.mdb';
  if (n === '1001' || /lone\s*star|lsb/.test(name)) return 'LJC at LSB new.mdb';
  if (n === '1002' || /\bcsb\b|community/.test(name)) return 'LJC at CSBnew.mdb';
  return EZCHECK_DEFAULT_COMPANY;
}
