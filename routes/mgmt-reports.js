/**
 * Property Management Report Import Routes
 * =========================================
 *
 * Upload a monthly report from a 3rd-party property manager (WestSide
 * Realty, MANAGErenthouses.com, or a future one), have it parsed into
 * structured income/expense line items, review/correct the parse if needed,
 * then generate a balanced DRAFT journal entry from it — the same "Due from
 * [management company]" pattern Jerry already books by hand.
 *
 * Endpoints (mounted at /api/mgmt-reports, behind JWT auth):
 *   POST   /upload             upload a PDF (or paste raw text) -> parsed record
 *   GET    /                   list records (filter by entityId / status)
 *   GET    /:id                get one, with parsed line items
 *   PATCH  /:id                correct parsed fields before posting
 *   POST   /:id/approve        mark reviewed (confirms the parse looks right)
 *   POST   /:id/create-journal build the DRAFT journal entry in journal_entries
 *   DELETE /:id                reject (only if no journal entry created yet)
 */

import express from 'express';
import crypto from 'crypto';
import { createRequire } from 'module';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../config/database.js';
import { parseManagementReport } from '../lib/mgmt-report-parser.js';
import { matchProperty, computeExpectedDepositDate } from '../lib/property-registry.js';
import {
  buildJournalEntryPlan,
  AR_ACCOUNT_NUMBER,
  REVENUE_ACCOUNT_NUMBER,
  DEFAULT_EXPENSE_ACCOUNT_NUMBER,
} from '../lib/mgmt-report-je.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const router = express.Router();

function dollars(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

async function getOrCreateAccount(db, entityId, { number, name, type, normal }) {
  let account = await db.get(
    'SELECT * FROM accounts WHERE entity_id = ? AND account_number = ?',
    [entityId, number]
  );
  if (!account) {
    const accId = `acc-${uuidv4()}`;
    await db.run(
      `INSERT INTO accounts (id, entity_id, account_number, account_name, account_type, normal_balance, is_active)
       VALUES (?, ?, ?, ?, ?, ?, true)`,
      [accId, entityId, number, name, type, normal]
    );
    account = await db.get('SELECT * FROM accounts WHERE id = ?', accId);
  }
  return account;
}

/** Load every account for the entity into a Map keyed by account_number. */
async function loadAccountsByNumber(db, entityId) {
  const rows = await db.all('SELECT * FROM accounts WHERE entity_id = ?', entityId);
  const map = new Map();
  for (const r of rows) map.set(r.account_number, r);
  return map;
}

function serialize(row) {
  return {
    id: row.id,
    entityId: row.entity_id,
    format: row.format,
    managementCompany: row.management_company,
    propertyRaw: row.property_raw,
    propertyCanonical: row.property_canonical,
    propertyMatched: !!row.property_matched,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    incomeLines: parseJson(row.income_lines, []),
    expenseLines: parseJson(row.expense_lines, []),
    otherLines: parseJson(row.other_lines, []),
    totalIncomeCents: row.total_income_cents,
    totalExpenseCents: row.total_expense_cents,
    netIncomeCents: row.net_income_cents,
    confidenceScore: row.confidence_score,
    status: row.status,
    needsReview: !!row.needs_review,
    notes: parseJson(row.notes, []),
    fileName: row.file_name,
    fileMime: row.file_mime,
    hasFile: !!row.file_data,
    journalEntryId: row.journal_entry_id,
    expectedDepositDate: row.expected_deposit_date,
    cashReceivedDate: row.cash_received_date,
    cashReceivedCents: row.cash_received_cents,
    cashVarianceCents: row.cash_variance_cents,
    // Invoice-style view on top of the same underlying data: once the accrual
    // journal entry exists, this report is effectively "billed" — an amount
    // due from the management company with a due date, open until cash is
    // confirmed received (see /mark-received).
    invoiceStatus: !row.journal_entry_id
      ? null
      : row.cash_received_date
        ? (row.cash_variance_cents ? 'PAID_VARIANCE' : 'PAID')
        : 'OPEN',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* -------------------------------------------------------------------- Upload */

router.post('/upload', async (req, res) => {
  try {
    const { entityId, fileName, fileMime, fileData, rawText: rawTextIn } = req.body;
    if (!entityId) return res.status(400).json({ error: 'entityId is required' });
    if (!fileData && !rawTextIn) {
      return res.status(400).json({ error: 'fileData (base64 PDF) or rawText is required' });
    }

    const db = await getDatabase();

    let rawText = rawTextIn || '';
    if (fileData && !rawText) {
      const mime = fileMime || '';
      if (mime.includes('pdf') || /\.pdf$/i.test(fileName || '')) {
        try {
          const buf = Buffer.from(fileData, 'base64');
          const parsed = await pdfParse(buf);
          rawText = parsed.text || '';
        } catch (err) {
          console.error('mgmt-reports pdf-parse failed:', err.message);
          rawText = '';
        }
      } else {
        // Plain text upload
        try { rawText = Buffer.from(fileData, 'base64').toString('utf8'); } catch { rawText = ''; }
      }
    }

    const idempotencyKey = crypto
      .createHash('sha256')
      .update(`${entityId}|${crypto.createHash('sha256').update(fileData || rawText).digest('hex')}`)
      .digest('hex');

    const existing = await db.get('SELECT * FROM mgmt_report_imports WHERE idempotency_key = ?', idempotencyKey);
    if (existing) {
      return res.status(200).json({ status: 'duplicate', record: serialize(existing) });
    }

    const parsed = parseManagementReport(rawText);
    const property = matchProperty(parsed.propertyRaw);
    const expectedDepositDate = computeExpectedDepositDate(parsed.managementCompany, parsed.periodEnd);

    const status = parsed.needsReview ? 'PENDING_REVIEW' : 'REVIEWED';
    const id = `mri-${uuidv4()}`;

    await db.run(
      `INSERT INTO mgmt_report_imports (
        id, entity_id, idempotency_key, format, management_company,
        property_raw, property_canonical, property_matched,
        period_start, period_end, income_lines, expense_lines, other_lines,
        total_income_cents, total_expense_cents, net_income_cents,
        confidence_score, status, needs_review, notes, raw_text,
        file_name, file_mime, file_data, expected_deposit_date, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, entityId, idempotencyKey, parsed.format, parsed.managementCompany,
        parsed.propertyRaw, property ? property.canonical : null, !!property,
        parsed.periodStart, parsed.periodEnd,
        JSON.stringify(parsed.incomeLines), JSON.stringify(parsed.expenseLines), JSON.stringify(parsed.otherLines),
        parsed.totalIncomeCents, parsed.totalExpenseCents, parsed.netIncomeCents,
        parsed.confidenceScore, status, parsed.needsReview ? true : false, JSON.stringify(parsed.notes),
        rawText,
        fileName || null, fileMime || null, fileData || null, expectedDepositDate, req.user.id,
      ]
    );

    const record = await db.get('SELECT * FROM mgmt_report_imports WHERE id = ?', id);
    res.status(201).json({ status: 'created', record: serialize(record) });
  } catch (error) {
    console.error('mgmt-reports upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

/* --------------------------------------------------------------------- List */

router.get('/', async (req, res) => {
  try {
    const { entityId, status } = req.query;
    const db = await getDatabase();
    const clauses = [];
    const params = [];
    if (entityId) { clauses.push('entity_id = ?'); params.push(entityId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await db.all(
      `SELECT * FROM mgmt_report_imports ${where} ORDER BY period_end DESC, created_at DESC`,
      ...params
    );
    res.json(rows.map(serialize));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const db = await getDatabase();
    const row = await db.get('SELECT * FROM mgmt_report_imports WHERE id = ?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(serialize(row));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Source document download — the original uploaded report, kept for audit trail /
// documentation on the journal entry it produced.
router.get('/:id/file', async (req, res) => {
  try {
    const db = await getDatabase();
    const row = await db.get('SELECT file_name, file_mime, file_data FROM mgmt_report_imports WHERE id = ?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!row.file_data) return res.status(404).json({ error: 'No file was attached to this report (it was entered as text).' });
    const buf = Buffer.from(row.file_data, 'base64');
    res.setHeader('Content-Type', row.file_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(row.file_name || 'report').replace(/"/g, '')}"`);
    res.send(buf);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ------------------------------------------------------------------- Review */

router.patch('/:id', async (req, res) => {
  try {
    const db = await getDatabase();
    const row = await db.get('SELECT * FROM mgmt_report_imports WHERE id = ?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.journal_entry_id) return res.status(409).json({ error: 'Already has a journal entry; cannot edit' });

    const body = req.body || {};
    const propertyRaw = body.propertyRaw !== undefined ? body.propertyRaw : row.property_raw;
    const managementCompany = body.managementCompany !== undefined ? body.managementCompany : row.management_company;
    const periodStart = body.periodStart !== undefined ? body.periodStart : row.period_start;
    const periodEnd = body.periodEnd !== undefined ? body.periodEnd : row.period_end;
    const incomeLines = body.incomeLines !== undefined ? body.incomeLines : parseJson(row.income_lines, []);
    const expenseLines = body.expenseLines !== undefined ? body.expenseLines : parseJson(row.expense_lines, []);
    const otherLines = body.otherLines !== undefined ? body.otherLines : parseJson(row.other_lines, []);

    const totalIncomeCents = incomeLines.reduce((s, l) => s + (l.cents || 0), 0);
    const totalExpenseCents = expenseLines.reduce((s, l) => s + (l.cents || 0), 0);
    const netIncomeCents = totalIncomeCents - totalExpenseCents;
    const property = matchProperty(propertyRaw);

    const needsReview = !property || (totalIncomeCents === 0 && totalExpenseCents === 0);
    const status = body.status || (needsReview ? 'PENDING_REVIEW' : 'REVIEWED');

    await db.run(
      `UPDATE mgmt_report_imports SET
        property_raw = ?, property_canonical = ?, property_matched = ?,
        management_company = ?, period_start = ?, period_end = ?,
        income_lines = ?, expense_lines = ?, other_lines = ?,
        total_income_cents = ?, total_expense_cents = ?, net_income_cents = ?,
        needs_review = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [
        propertyRaw, property ? property.canonical : null, !!property,
        managementCompany, periodStart, periodEnd,
        JSON.stringify(incomeLines), JSON.stringify(expenseLines), JSON.stringify(otherLines),
        totalIncomeCents, totalExpenseCents, netIncomeCents,
        needsReview ? true : false, status,
        req.params.id,
      ]
    );

    const updated = await db.get('SELECT * FROM mgmt_report_imports WHERE id = ?', req.params.id);
    res.json(serialize(updated));
  } catch (error) {
    console.error('mgmt-reports patch error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const db = await getDatabase();
    const row = await db.get('SELECT * FROM mgmt_report_imports WHERE id = ?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await db.run(
      "UPDATE mgmt_report_imports SET status = 'REVIEWED', needs_review = false, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      req.params.id
    );
    const updated = await db.get('SELECT * FROM mgmt_report_imports WHERE id = ?', req.params.id);
    res.json(serialize(updated));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ----------------------------------------------------------- Journal entry */

router.post('/:id/create-journal', async (req, res) => {
  try {
    const db = await getDatabase();
    const row = await db.get('SELECT * FROM mgmt_report_imports WHERE id = ?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.journal_entry_id) return res.status(409).json({ error: 'Journal entry already created for this report' });

    const property = matchProperty(row.property_raw);
    if (!property) {
      return res.status(400).json({ error: `Could not match "${row.property_raw}" to a known property/entity. Correct it via PATCH first.` });
    }

    const entityId = property.entityId;
    const parsed = {
      managementCompany: row.management_company,
      propertyRaw: row.property_raw,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      incomeLines: parseJson(row.income_lines, []),
      expenseLines: parseJson(row.expense_lines, []),
      totalIncomeCents: row.total_income_cents,
      totalExpenseCents: row.total_expense_cents,
    };

    if (!parsed.totalIncomeCents && !parsed.totalExpenseCents) {
      return res.status(400).json({ error: 'No income or expense activity to book for this period.' });
    }

    // Make sure the core accounts exist (auto-provision for a brand new entity;
    // for ent-ljc today these already exist, so this is a no-op lookup).
    await getOrCreateAccount(db, entityId, { number: AR_ACCOUNT_NUMBER, name: 'Accounts Receivable', type: 'ASSET', normal: 'DEBIT' });
    await getOrCreateAccount(db, entityId, { number: REVENUE_ACCOUNT_NUMBER, name: 'Rental Income', type: 'REVENUE', normal: 'CREDIT' });
    await getOrCreateAccount(db, entityId, { number: DEFAULT_EXPENSE_ACCOUNT_NUMBER, name: 'Rental Property Expenses', type: 'EXPENSE', normal: 'DEBIT' });

    const accountsByNumber = await loadAccountsByNumber(db, entityId);
    const plan = buildJournalEntryPlan(parsed, property, accountsByNumber);

    if (!plan.canPost) {
      return res.status(400).json({ error: 'Could not build a balanced journal entry', plan });
    }

    const journalId = `je-${uuidv4()}`;
    const jeNumber = `MGMT-${Date.now()}`;

    await db.run(
      `INSERT INTO journal_entries
       (id, entity_id, je_number, description, posting_date, status, created_by, memo, total_debit, total_credit)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
      [
        journalId, entityId, jeNumber, plan.description, plan.postingDate,
        req.user.id, `mgmt-report-import:${row.id}`,
        dollars(plan.totalDebitCents), dollars(plan.totalCreditCents),
      ]
    );

    for (let i = 0; i < plan.lines.length; i++) {
      const line = plan.lines[i];
      await db.run(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [`jel-${uuidv4()}`, journalId, line.account.id, dollars(line.debitCents), dollars(line.creditCents), line.description, i + 1]
      );
    }

    await db.run(
      "UPDATE mgmt_report_imports SET status = 'DRAFT_CREATED', journal_entry_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [journalId, req.params.id]
    );

    const updated = await db.get('SELECT * FROM mgmt_report_imports WHERE id = ?', req.params.id);
    res.status(201).json({
      record: serialize(updated),
      journalEntryId: journalId,
      jeNumber,
      entityId,
      totalDebit: dollars(plan.totalDebitCents),
      totalCredit: dollars(plan.totalCreditCents),
      message: 'Draft journal entry created. Review and post it from Journal Entries.',
    });
  } catch (error) {
    console.error('mgmt-reports create-journal error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Recompute the expected-deposit-date from the current management-company
// schedule (lib/property-registry.js). Safe to call any time, including
// after a journal entry exists — it only touches the display-only due date,
// never the accrual figures — so it can backfill records created before a
// company's remittance schedule was confirmed.
router.post('/:id/recompute-expected-date', async (req, res) => {
  try {
    const db = await getDatabase();
    const row = await db.get('SELECT * FROM mgmt_report_imports WHERE id = ?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const expectedDepositDate = computeExpectedDepositDate(row.management_company, row.period_end);
    await db.run(
      'UPDATE mgmt_report_imports SET expected_deposit_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [expectedDepositDate, req.params.id]
    );
    const updated = await db.get('SELECT * FROM mgmt_report_imports WHERE id = ?', req.params.id);
    res.json(serialize(updated));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* --------------------------------------------------------- Confirm receipt */

// Manually confirm the manager's actual cash remittance against the net
// amount this report said was due — the "does the deposit match the report"
// check. This does NOT touch the ledger (the bank-feed reconciliation flow
// already books the actual cash entry); it just records the confirmation so
// it's visible on this screen, with a variance flag if they don't match.
router.post('/:id/mark-received', async (req, res) => {
  try {
    const db = await getDatabase();
    const row = await db.get('SELECT * FROM mgmt_report_imports WHERE id = ?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const { cashReceivedDate, cashReceivedCents } = req.body || {};
    if (cashReceivedCents == null || Number.isNaN(Number(cashReceivedCents))) {
      return res.status(400).json({ error: 'cashReceivedCents is required' });
    }
    const variance = Number(cashReceivedCents) - Number(row.net_income_cents || 0);

    await db.run(
      `UPDATE mgmt_report_imports SET
        cash_received_date = ?, cash_received_cents = ?, cash_variance_cents = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [cashReceivedDate || new Date().toISOString().slice(0, 10), Math.round(Number(cashReceivedCents)), variance, req.params.id]
    );

    const updated = await db.get('SELECT * FROM mgmt_report_imports WHERE id = ?', req.params.id);
    res.json({ record: serialize(updated), matches: variance === 0, varianceCents: variance });
  } catch (error) {
    console.error('mgmt-reports mark-received error:', error);
    res.status(500).json({ error: error.message });
  }
});

/* ------------------------------------------------------------------ Reject */

router.delete('/:id', async (req, res) => {
  try {
    const db = await getDatabase();
    const row = await db.get('SELECT * FROM mgmt_report_imports WHERE id = ?', req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.journal_entry_id) return res.status(409).json({ error: 'Already posted to a journal entry; reverse the JE instead of deleting this' });
    await db.run('DELETE FROM mgmt_report_imports WHERE id = ?', req.params.id);
    res.json({ message: 'Rejected' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
