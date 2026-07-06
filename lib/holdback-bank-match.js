/**
 * Match outgoing holdback wires from bank feeds to holdback_disbursements rows.
 * Handles wire retries where net amount drops by $70 per failed attempt ($35 return + $35 resend).
 */

const WIRE_RETRY_FEE_PAIR = 70;
const MAX_WIRE_RETRY_ATTEMPTS = 5;
const AMOUNT_TOLERANCE = 0.02;

const HOLDABCK_WIRE_DEBIT_RE = /WIRE\s*TRANSFER\s*DEBIT/i;

export function isHoldbackWireDebit(description) {
  return HOLDABCK_WIRE_DEBIT_RE.test(String(description || ''));
}

/** Extract searchable tokens from borrower name (handles CALACTA / CALCATA typos). */
export function borrowerWireTokens(borrowerName) {
  const tokens = new Set();
  const firstLine = String(borrowerName || '').split('\n')[0].trim();
  if (!firstLine) return tokens;

  const upper = firstLine.toUpperCase();
  tokens.add(upper);

  const alpha = upper.replace(/[^A-Z]/g, '');
  if (alpha.length >= 5) tokens.add(alpha);

  // Common bank truncation: "CALACTA CONS", "CALCATA CONSTRUCTION"
  const words = upper.split(/\s+/).filter((w) => w.length >= 4);
  for (const w of words) tokens.add(w);

  return tokens;
}

export function borrowerMatchesWireDescription(borrowerName, description) {
  const hay = String(description || '').toUpperCase();
  if (!hay) return false;

  for (const token of borrowerWireTokens(borrowerName)) {
    if (token.length >= 5 && hay.includes(token)) return true;
  }

  // Known typo pair for Calacta
  if (/\bCALACTA\b|\bCALCATA\b/.test(hay)) {
    const borrower = String(borrowerName || '').toUpperCase();
    if (borrower.includes('CALACTA') || borrower.includes('CALCATA')) return true;
  }

  return false;
}

/**
 * True when bank debit amount matches draw net, including wire-retry fee deductions.
 */
export function wireAmountMatchesDraw(netDisbursement, bankAmount, description = '') {
  const net = Math.abs(Number(netDisbursement) || 0);
  const absAmt = Math.abs(Number(bankAmount) || 0);
  if (!net || !absAmt) return false;

  if (Math.abs(net - absAmt) < AMOUNT_TOLERANCE) return true;

  // Each failed wire attempt typically costs $35 return + $35 resend = $70 off the net wire.
  for (let attempts = 1; attempts <= MAX_WIRE_RETRY_ATTEMPTS; attempts += 1) {
    const adjusted = net - attempts * WIRE_RETRY_FEE_PAIR;
    if (adjusted > 0 && Math.abs(adjusted - absAmt) < AMOUNT_TOLERANCE) return true;
  }

  // Parse "2ND ATTEMPT" / "3RD ATTEMPT" from Simmons wire memo when present.
  const attemptMatch = String(description || '').match(/(\d+)(?:ST|ND|RD|TH)\s+ATTEMPT/i);
  if (attemptMatch) {
    const attemptNum = Math.max(0, Number(attemptMatch[1]) - 1);
    const adjusted = net - attemptNum * WIRE_RETRY_FEE_PAIR;
    if (adjusted > 0 && Math.abs(adjusted - absAmt) < AMOUNT_TOLERANCE) return true;
  }

  return false;
}

function wireAttemptNumber(description) {
  const m = String(description || '').match(/(\d+)(?:ST|ND|RD|TH)\s+ATTEMPT/i);
  return m ? Number(m[1]) : 0;
}

function scoreDrawMatch(row, { amount, description }) {
  const absAmt = Math.abs(Number(amount) || 0);
  const amountHit = wireAmountMatchesDraw(row.net_disbursement, absAmt, description);
  const nameHit = borrowerMatchesWireDescription(row.borrower_name, description);
  const memoHit = description.includes(`HOLDBACK-DRAW:${row.draw_id}`)
    || String(row.memo || '').includes(`HOLDBACK-DRAW:${row.draw_id}`);

  let score = 0;
  if (amountHit) score += 40;
  if (nameHit) score += 30;
  if (memoHit) score += 50;
  if (isHoldbackWireDebit(description) && Number(amount) < 0) score += 10;
  score += wireAttemptNumber(description) * 5;

  return { score, amountHit, nameHit, memoHit };
}

/**
 * Find the best holdback draw for an outgoing bank wire.
 * Prefers exported/matched (not yet verified) draws with name + amount alignment.
 */
export async function findHoldbackDrawForBankTxn(db, { entityId, importTransaction }) {
  if (!importTransaction) return null;

  const amount = Number(importTransaction.amount) || 0;
  const description = `${importTransaction.description || ''} ${importTransaction.check_number || ''}`;

  // Only match outgoing wires (debits) to holdback disbursements.
  if (amount >= 0) return null;
  if (!isHoldbackWireDebit(description)) return null;

  const rows = await db.all(
    `SELECT * FROM holdback_disbursements
     WHERE entity_id = ? AND status IN ('exported', 'matched', 'verified')
     ORDER BY draw_date DESC`,
    [entityId]
  );

  let best = null;
  let bestScore = 0;

  for (const row of rows) {
    const { score, amountHit, nameHit, memoHit } = scoreDrawMatch(row, { amount, description });
    if (score < 50) continue; // need name or memo plus amount, or strong memo hit
    if (!amountHit && !memoHit) continue;
    if (!amountHit && !nameHit) continue;

    const dateHit = !importTransaction.date || !row.draw_date
      || Math.abs(new Date(importTransaction.date) - new Date(row.draw_date)) <= 30 * 86400000;
    if (!dateHit) continue;

    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }

  return best;
}

export { wireAttemptNumber };
