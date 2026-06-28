/**
 * Smoke test Simmons holdback journal math (no server).
 */
import { getDatabase } from '../config/database.js';
import {
  ensureHoldbackTable,
  createHoldbackFundsReceivedJournal,
  createHoldbackDisbursementJournal,
} from '../lib/holdback-disbursement.js';

const drawId = `draw-simmons-test-${Date.now()}`;
const entityId = 'ent-ljc';
const userId = 'usr-demo';
const gross = 28000;
const inspection = 150;
const wire = 35;
const net = 27815;

const db = await getDatabase();
await ensureHoldbackTable(db);

const funds = await createHoldbackFundsReceivedJournal(db, {
  entityId,
  userId,
  drawId,
  drawDate: '2026-06-24',
  grossAmount: gross,
  borrowerName: 'Test Borrower',
  loanNum: 'TEST-001',
});

const disburse = await createHoldbackDisbursementJournal(db, {
  entityId,
  userId,
  drawId,
  drawDate: '2026-06-24',
  grossAmount: gross,
  inspectionFee: inspection,
  wireFee: wire,
  netDisbursement: net,
  borrowerName: 'Test Borrower',
  loanNum: 'TEST-001',
});

const lines = await db.all(
  `SELECT a.account_number, jel.debit, jel.credit
   FROM journal_entry_lines jel
   JOIN accounts a ON a.id = jel.account_id
   WHERE jel.journal_entry_id IN (?, ?)
   ORDER BY jel.journal_entry_id, jel.line_number`,
  [funds.journalId, disburse.journalId]
);

let dr = 0;
let cr = 0;
for (const l of lines) {
  dr += Number(l.debit);
  cr += Number(l.credit);
  console.log(`${l.account_number} DR ${l.debit} CR ${l.credit}`);
}
console.log('Total DR', dr, 'CR', cr, dr === cr ? 'OK' : 'FAIL');
process.exit(dr === cr ? 0 : 1);
