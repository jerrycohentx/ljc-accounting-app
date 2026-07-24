import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { getDatabase } from '../config/database.js';
import { entityAccessMiddleware, requireRole } from '../middleware/auth.js';
import { assertNotPlugJournal } from '../lib/period-integrity.js';
import { postJournalEntryToGl } from '../lib/post-journal.js';
import { reverseJournalEntry } from '../lib/reverse-journal.js';

const router = express.Router({ mergeParams: true });

// Backup-document plumbing at the JE level: staple a source PDF (statement/invoice)
// to any journal entry — the manual-entry equivalent of the mgmt-report import link.
let jeDocsReady = false;
async function ensureJeDocsTable(db) {
  if (jeDocsReady) return;
  await db.run(`CREATE TABLE IF NOT EXISTS journal_entry_documents (
    id TEXT PRIMARY KEY,
    journal_entry_id TEXT NOT NULL,
    file_name TEXT,
    file_mime TEXT,
    file_data TEXT,
    uploaded_by TEXT,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  jeDocsReady = true;
}

// GET /api/entities/:entityId/journals - List journal entries
router.get('/', entityAccessMiddleware, async (req, res) => {
  try {
    const { status, startDate, endDate, page = 1, limit = 50 } = req.query;
    const db = await getDatabase();
    let query = 'SELECT * FROM journal_entries WHERE entity_id = ?';
    const params = [req.entityId];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    if (startDate) {
      query += ' AND posting_date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND posting_date <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY posting_date DESC, created_at DESC LIMIT ? OFFSET ?';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit), offset);

    const journals = await db.all(query, params);

    res.json({
      data: journals,
      pagination: { page: parseInt(page), limit: parseInt(limit) }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/journals/:id - Get single JE with lines
router.get('/:id', entityAccessMiddleware, async (req, res) => {
  try {
    const db = await getDatabase();
    const journal = await db.get(
      'SELECT * FROM journal_entries WHERE id = ? AND entity_id = ?',
      [req.params.id, req.entityId]
    );

    if (!journal) {
      return res.status(404).json({ error: 'Journal entry not found' });
    }

    const lines = await db.all(
      `SELECT jel.*, a.account_number, a.account_name 
       FROM journal_entry_lines jel
       JOIN accounts a ON jel.account_id = a.id
       WHERE jel.journal_entry_id = ?
       ORDER BY jel.line_number`,
      req.params.id
    );

    let sourceDocument = null;
    try {
      const mri = await db.get(
        'SELECT id, file_name, file_mime, file_data FROM mgmt_report_imports WHERE journal_entry_id = ?',
        req.params.id
      );
      if (mri) {
        sourceDocument = {
          mgmtReportId: mri.id,
          fileName: mri.file_name,
          fileMime: mri.file_mime,
          hasFile: !!mri.file_data,
        };
      }
    } catch {
      // mgmt_report_imports may not exist yet on older deploys — non-fatal.
    }

    // Fall back to a manually-attached backup document (JE-level attachment feature).
    if (!sourceDocument) {
      try {
        await ensureJeDocsTable(db);
        const doc = await db.get(
          'SELECT id, file_name, file_mime, file_data FROM journal_entry_documents WHERE journal_entry_id = ? ORDER BY uploaded_at DESC LIMIT 1',
          req.params.id
        );
        if (doc) {
          sourceDocument = {
            documentId: doc.id,
            fileName: doc.file_name,
            fileMime: doc.file_mime,
            hasFile: !!doc.file_data,
          };
        }
      } catch {
        // journal_entry_documents may not exist yet — non-fatal.
      }
    }

    res.json({ ...journal, lines, sourceDocument });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/journals - Create new JE
router.post('/', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { description, postingDate, lines, memo, source } = req.body;

    if (!description || !postingDate || !lines || lines.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    assertNotPlugJournal({ source, description });

    const db = await getDatabase();

    // Validate accounts exist
    for (const line of lines) {
      const account = await db.get(
        'SELECT id FROM accounts WHERE id = ? AND entity_id = ?',
        [line.accountId, req.entityId]
      );
      if (!account) {
        return res.status(400).json({ error: `Account ${line.accountId} not found` });
      }
    }

    const journalId = `je-${uuidv4()}`;
    const jeNumber = `JE-${Date.now()}`;

    // Calculate totals
    const totals = lines.reduce((acc, line) => ({
      debit: new Decimal(acc.debit).plus(line.debit || 0),
      credit: new Decimal(acc.credit).plus(line.credit || 0)
    }), { debit: 0, credit: 0 });

    // Create JE header
    await db.run(
      `INSERT INTO journal_entries 
       (id, entity_id, je_number, description, posting_date, status, created_by, memo, total_debit, total_credit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [journalId, req.entityId, jeNumber, description, postingDate, 'DRAFT', 
       req.user.id, memo, totals.debit.toString(), totals.credit.toString()]
    );

    // Create JE lines
    for (let i = 0; i < lines.length; i++) {
      const lineId = `jel-${uuidv4()}`;
      await db.run(
        `INSERT INTO journal_entry_lines 
         (id, journal_entry_id, account_id, debit, credit, description, line_number)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [lineId, journalId, lines[i].accountId, lines[i].debit || 0, 
         lines[i].credit || 0, lines[i].description, i + 1]
      );
    }

    res.status(201).json({
      id: journalId,
      jeNumber,
      status: 'DRAFT',
      totalDebit: totals.debit.toString(),
      totalCredit: totals.credit.toString()
    });
    } catch (error) {
    if (error.code === 'PLUG_ENTRY_BLOCKED') {
      return res.status(403).json({ error: error.message, code: error.code });
    }
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/entities/:entityId/journals/:id - Update draft JE
router.put('/:id', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { description, postingDate, lines, memo, source } = req.body;
    assertNotPlugJournal({ source, description });
    const db = await getDatabase();

    const journal = await db.get(
      'SELECT * FROM journal_entries WHERE id = ? AND entity_id = ?',
      [req.params.id, req.entityId]
    );

    if (!journal) {
      return res.status(404).json({ error: 'Journal entry not found' });
    }

    if (journal.status !== 'DRAFT') {
      return res.status(409).json({ error: 'Can only edit draft journal entries' });
    }

    // Update header
    await db.run(
      'UPDATE journal_entries SET description = ?, posting_date = ?, memo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [description || journal.description, postingDate || journal.posting_date, memo || journal.memo, req.params.id]
    );

    // Update lines if provided
    if (lines) {
      await db.run('DELETE FROM journal_entry_lines WHERE journal_entry_id = ?', req.params.id);

      const totals = lines.reduce((acc, line) => ({
        debit: new Decimal(acc.debit).plus(line.debit || 0),
        credit: new Decimal(acc.credit).plus(line.credit || 0)
      }), { debit: 0, credit: 0 });

      for (let i = 0; i < lines.length; i++) {
        const lineId = `jel-${uuidv4()}`;
        await db.run(
          `INSERT INTO journal_entry_lines 
           (id, journal_entry_id, account_id, debit, credit, description, line_number)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [lineId, req.params.id, lines[i].accountId, lines[i].debit || 0, 
           lines[i].credit || 0, lines[i].description, i + 1]
        );
      }

      await db.run(
        'UPDATE journal_entries SET total_debit = ?, total_credit = ? WHERE id = ?',
        [totals.debit.toString(), totals.credit.toString(), req.params.id]
      );
    }

    res.json({ message: 'Journal entry updated' });
  } catch (error) {
    if (error.code === 'PLUG_ENTRY_BLOCKED') {
      return res.status(403).json({ error: error.message, code: error.code });
    }
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/journals/:id/approve - Approve JE
router.post('/:id/approve', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const db = await getDatabase();
    const journal = await db.get(
      'SELECT * FROM journal_entries WHERE id = ? AND entity_id = ?',
      [req.params.id, req.entityId]
    );

    if (!journal) {
      return res.status(404).json({ error: 'Journal entry not found' });
    }

    if (journal.status !== 'DRAFT') {
      return res.status(409).json({ error: 'Can only approve draft entries' });
    }

    // Validate debits = credits
    if (!new Decimal(journal.total_debit).equals(journal.total_credit)) {
      return res.status(400).json({ error: 'Journal entry does not balance (debits ≠ credits)' });
    }

    await db.run(
      'UPDATE journal_entries SET status = ?, approved_by = ?, approved_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['APPROVED', req.user.id, req.params.id]
    );

    res.json({ message: 'Journal entry approved' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/journals/:id/post - Post JE to GL (DRAFT auto-approved)
router.post('/:id/post', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const db = await getDatabase();
    const result = await postJournalEntryToGl(db, {
      journalId: req.params.id,
      entityId: req.entityId,
      userId: req.user.id,
    });
    res.json({ message: 'Journal entry posted to GL', ...result });
  } catch (error) {
    if (error.message.includes('not found')) return res.status(404).json({ error: error.message });
    if (error.message.includes('already posted')) return res.status(409).json({ error: error.message });
    if (error.message.includes('closed period')) return res.status(409).json({ error: error.message });
    if (error.code === 'PLUG_ENTRY_BLOCKED') {
      return res.status(403).json({ error: error.message, code: error.code });
    }
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/journals/:id/reverse - Reverse a posted JE
router.post('/:id/reverse', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { reversalDate, memo } = req.body || {};
    const db = await getDatabase();
    const result = await reverseJournalEntry(db, {
      journalId: req.params.id,
      entityId: req.entityId,
      userId: req.user.id,
      reversalDate,
      memo,
    });
    res.json({ message: 'Journal entry reversed', ...result });
  } catch (error) {
    if (error.message.includes('not found')) return res.status(404).json({ error: error.message });
    if (/already been reversed|Only posted|Cannot reverse|closed period/i.test(error.message)) {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

// POST /api/entities/:entityId/journals/:id/document - attach a backup document (base64) to a JE
router.post('/:id/document', [entityAccessMiddleware, requireRole('ADMIN', 'ACCOUNTANT')], async (req, res) => {
  try {
    const { fileName, fileMime, fileData } = req.body || {};
    if (!fileData) return res.status(400).json({ error: 'fileData (base64) is required' });

    const db = await getDatabase();
    const je = await db.get(
      'SELECT id FROM journal_entries WHERE id = ? AND entity_id = ?',
      [req.params.id, req.entityId]
    );
    if (!je) return res.status(404).json({ error: 'Journal entry not found' });

    await ensureJeDocsTable(db);
    const id = `jed-${uuidv4()}`;
    await db.run(
      `INSERT INTO journal_entry_documents (id, journal_entry_id, file_name, file_mime, file_data, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.params.id, fileName || null, fileMime || 'application/pdf', fileData, req.user?.id || null]
    );
    res.status(201).json({ id, journalEntryId: req.params.id, fileName: fileName || null, fileMime: fileMime || 'application/pdf' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/entities/:entityId/journals/:id/document - download the attached backup document
router.get('/:id/document', entityAccessMiddleware, async (req, res) => {
  try {
    const db = await getDatabase();
    await ensureJeDocsTable(db);
    const doc = await db.get(
      'SELECT file_name, file_mime, file_data FROM journal_entry_documents WHERE journal_entry_id = ? ORDER BY uploaded_at DESC LIMIT 1',
      req.params.id
    );
    if (!doc || !doc.file_data) return res.status(404).json({ error: 'No document attached' });
    const buf = Buffer.from(doc.file_data, 'base64');
    const safeName = (doc.file_name || 'document.pdf').replace(/[^A-Za-z0-9._-]+/g, '_');
    res.setHeader('Content-Type', doc.file_mime || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Content-Length', buf.length);
    return res.end(buf);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
