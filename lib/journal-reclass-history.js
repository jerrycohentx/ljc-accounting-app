/**
 * Effective category history for a posted journal entry.
 *
 * Original JE lines are immutable. Category corrections are append-only:
 *   - reclass-offset:<jeId>:<lineId>:<toAccountId>  (manual Fix category)
 *   - reclass-rules:<jeId>:<glId>                   (bulk learned-rule reclass)
 *
 * The reconcile register and Transaction Detail must both consume this history
 * so the Category column and the detail ledger always agree.
 */

/**
 * @param {import('sqlite').Database} db
 * @param {string} entityId
 * @param {string} journalId
 * @param {Array<object>} lines  JE lines with account_id / account_number / account_name / debit / credit
 * @returns {Promise<Array<object>>}
 */
export async function getReclassHistoryForJournal(db, entityId, journalId, lines = []) {
  if (!db || !entityId || !journalId) return [];

  const items = [];

  // 1) Manual Fix category offsets
  const offsetRows = await db.all(
    `SELECT id, je_number, memo, description, posting_date, created_at, total_debit
     FROM journal_entries
     WHERE entity_id = ? AND status = 'POSTED' AND reversed_by_je_id IS NULL
       AND memo LIKE ?
     ORDER BY posting_date ASC, created_at ASC, je_number ASC`,
    [entityId, `reclass-offset:${journalId}:%`]
  );
  for (const row of offsetRows || []) {
    const parts = String(row.memo || '').split(':');
    // reclass-offset : journalId : lineId : toAccountId
    if (parts.length < 4 || parts[0] !== 'reclass-offset') continue;
    const lineId = parts[2] || null;
    const toAccountId = parts[3] || null;
    let toAccount = null;
    let fromAccount = null;
    if (toAccountId) {
      toAccount = await db.get(
        'SELECT id, account_number, account_name FROM accounts WHERE id = ?',
        [toAccountId]
      );
    }
    const origLine = (lines || []).find((l) => String(l.id) === String(lineId));
    if (origLine) {
      fromAccount = {
        id: origLine.account_id,
        account_number: origLine.account_number,
        account_name: origLine.account_name,
      };
    }
    items.push({
      source: 'offset',
      reclassJeId: row.id,
      reclassJeNumber: row.je_number,
      lineId,
      amount: Number(row.total_debit) || 0,
      postingDate: row.posting_date,
      createdAt: row.created_at,
      description: row.description,
      fromAccount,
      toAccount,
      toAccountId: toAccount?.id || toAccountId,
    });
  }

  // 2) Learned-rule bulk reclasses (keyed by GL id, mapped back to JE line)
  const ruleRows = await db.all(
    `SELECT id, je_number, memo, description, posting_date, created_at, total_debit
     FROM journal_entries
     WHERE entity_id = ? AND status = 'POSTED' AND reversed_by_je_id IS NULL
       AND memo LIKE ?
     ORDER BY posting_date ASC, created_at ASC, je_number ASC`,
    [entityId, `reclass-rules:${journalId}:%`]
  );

  for (const row of ruleRows || []) {
    const parts = String(row.memo || '').split(':');
    // reclass-rules : journalId : glId
    if (parts.length < 3 || parts[0] !== 'reclass-rules') continue;
    const glId = parts[2];
    if (!glId) continue;

    const gl = await db.get(
      `SELECT id, account_id, COALESCE(debit, 0) AS debit, COALESCE(credit, 0) AS credit
       FROM general_ledger WHERE id = ? AND entity_id = ?`,
      [glId, entityId]
    );
    if (!gl) continue;

    const linePool = (lines || []).filter((l) => String(l.account_id) === String(gl.account_id));
    const origLine = linePool.find((l) =>
      Math.abs((Number(l.debit) || 0) - Number(gl.debit)) < 0.02
      && Math.abs((Number(l.credit) || 0) - Number(gl.credit)) < 0.02
    ) || linePool[0];
    if (!origLine) continue;

    const fromAccount = {
      id: origLine.account_id,
      account_number: origLine.account_number,
      account_name: origLine.account_name,
    };

    // Target = non-clearing expense/income line on the RCLS-RULE JE
    const rclsLines = await db.all(
      `SELECT jel.id AS line_id, jel.account_id,
              COALESCE(jel.debit, 0) AS debit, COALESCE(jel.credit, 0) AS credit,
              a.account_number, a.account_name, a.account_type
       FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = ?`,
      [row.id]
    );
    const prefer = (rclsLines || []).filter((l) =>
      /EXPENSE|INCOME|COST OF GOODS/i.test(String(l.account_type || ''))
      && String(l.account_id) !== String(fromAccount.id)
    );
    const pool = prefer.length ? prefer : (rclsLines || []).filter((l) => String(l.account_id) !== String(fromAccount.id));
    pool.sort((a, b) => Math.abs(b.debit - b.credit) - Math.abs(a.debit - a.credit));
    let pick = pool[0];
    if (!pick) continue;

    // Chained Fix category on the RCLS JE itself (e.g. wrong rule target → correct account)
    const chain = await db.get(
      `SELECT memo FROM journal_entries
       WHERE entity_id = ? AND status = 'POSTED' AND reversed_by_je_id IS NULL
         AND memo LIKE ?
       ORDER BY created_at DESC, je_number DESC
       LIMIT 1`,
      [entityId, `reclass-offset:${row.id}:${pick.line_id}:%`]
    );
    if (chain?.memo) {
      const cParts = String(chain.memo).split(':');
      const chainedToId = cParts[3];
      if (chainedToId) {
        const chainedAcct = await db.get(
          'SELECT id, account_number, account_name FROM accounts WHERE id = ?',
          [chainedToId]
        );
        if (chainedAcct) {
          pick = {
            ...pick,
            account_id: chainedAcct.id,
            account_number: chainedAcct.account_number,
            account_name: chainedAcct.account_name,
          };
        }
      }
    }

    const toAccount = {
      id: pick.account_id,
      account_number: pick.account_number,
      account_name: pick.account_name,
    };

    items.push({
      source: 'rules',
      reclassJeId: row.id,
      reclassJeNumber: row.je_number,
      lineId: origLine.id,
      glId,
      amount: Number(row.total_debit) || 0,
      postingDate: row.posting_date,
      createdAt: row.created_at,
      description: row.description,
      fromAccount,
      toAccount,
      toAccountId: toAccount.id,
    });
  }

  items.sort((a, b) => {
    const da = String(a.postingDate || '');
    const db_ = String(b.postingDate || '');
    if (da !== db_) return da.localeCompare(db_);
    const ca = String(a.createdAt || '');
    const cb = String(b.createdAt || '');
    if (ca !== cb) return ca.localeCompare(cb);
    return String(a.reclassJeNumber || '').localeCompare(String(b.reclassJeNumber || ''));
  });

  return items;
}

/**
 * Effective "from" account for a new Fix category on a JE line —
 * latest unreverted correction (offset or rules), else the original line account.
 *
 * @returns {Promise<{ fromAccountId: string, fromAccountNumber?: string|null, via?: string|null }>}
 */
export async function resolveEffectiveFromAccount(db, {
  entityId,
  journalId,
  lineId,
  originalAccountId,
  originalAccountNumber = null,
} = {}) {
  const lines = await db.all(
    `SELECT jel.*, a.account_number, a.account_name
     FROM journal_entry_lines jel
     JOIN accounts a ON a.id = jel.account_id
     WHERE jel.journal_entry_id = ?
     ORDER BY jel.line_number`,
    [journalId]
  );
  const history = await getReclassHistoryForJournal(db, entityId, journalId, lines);
  const forLine = history.filter((h) => String(h.lineId) === String(lineId) && h.toAccount?.id);
  if (forLine.length) {
    const latest = forLine[forLine.length - 1];
    return {
      fromAccountId: latest.toAccount.id,
      fromAccountNumber: latest.toAccount.account_number || null,
      via: latest.source || null,
    };
  }
  return {
    fromAccountId: originalAccountId,
    fromAccountNumber: originalAccountNumber,
    via: null,
  };
}
