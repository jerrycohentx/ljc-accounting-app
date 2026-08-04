import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SUPPORT_DOC_DIR = path.join(ROOT, 'logs', 'ai-copilot', 'support');
const DEFAULT_THRESHOLD = Number(process.env.COPILOT_CONFIDENCE_THRESHOLD || 0.85);

const OUTFLOW_RULES = [
  { pattern: /\binterest\b/i, accountNumbers: ['5000'], reason: 'Interest keyword detected (expense outflow).' },
  { pattern: /\b(service charge|overdraft|wire fee|nsf|bank fee)\b/i, accountNumbers: ['5100'], reason: 'Bank fee keyword detected (operating expense).' },
  { pattern: /\b(utilities?|internet|phone|electric|water)\b/i, accountNumbers: ['5100'], reason: 'Utility keyword detected (operating expense).' },
  { pattern: /\b(insurance|repairs?|maintenance|supplies|office)\b/i, accountNumbers: ['5100'], reason: 'Operating expense keyword detected.' },
  { pattern: /\b(loan payment|principal|warehouse line|notes payable)\b/i, accountNumbers: ['2100', '2200'], reason: 'Liability payment keyword detected.' },
];

const INFLOW_RULES = [
  { pattern: /\binterest\b/i, accountNumbers: ['4000'], reason: 'Interest keyword detected (interest income).' },
  { pattern: /\b(fee income|origination|late fee|service fee)\b/i, accountNumbers: ['4100'], reason: 'Fee keyword detected (fee income).' },
  { pattern: /\b(owner contribution|capital contribution|equity)\b/i, accountNumbers: ['3000'], reason: 'Capital contribution keyword detected (equity).' },
  { pattern: /\b(refund|reversal)\b/i, accountNumbers: ['5100'], reason: 'Refund keyword detected (offset prior expense).' },
];

function toCents(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function centsToAmount(cents) {
  return (cents / 100).toFixed(2);
}

function toIsoDay(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

function normalizeDescription(desc) {
  return String(desc || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function descriptionTokens(desc) {
  return normalizeDescription(desc)
    .split(' ')
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token));
}

function txDirection(amountCents) {
  return amountCents >= 0 ? 'inflow' : 'outflow';
}

function buildFingerprint({ accountId, description, amountCents }) {
  const tokens = descriptionTokens(description).slice(0, 4).join('_') || 'unknown';
  return `${accountId}|${txDirection(amountCents)}|${tokens}`;
}

function clampConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return Math.round(n * 100) / 100;
}

function assertBalanced(lines) {
  const totalSignedMinor = lines.reduce((sum, line) => {
    const debitCents = Number(line.debit_cents || 0);
    const creditCents = Number(line.credit_cents || 0);
    return sum + debitCents - creditCents;
  }, 0);
  if (totalSignedMinor !== 0) {
    throw new Error(`Journal out of balance in copilot proposal (delta cents: ${totalSignedMinor})`);
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function parseSuggestionJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function suggestedOffsetAccountId(suggestion) {
  return suggestion?.lines?.find((line) => line.role === 'offset')?.account_id || null;
}

export class AIAccountingCopilotService {
  constructor(db, {
    entityId,
    userId = 'usr-admin',
    confidenceThreshold = DEFAULT_THRESHOLD,
  }) {
    this.db = db;
    this.entityId = entityId;
    this.userId = userId;
    this.confidenceThreshold = Number(confidenceThreshold);
    this.accounts = [];
    this.accountsById = new Map();
    this.accountsByNumber = new Map();
  }

  async init() {
    await this.ensureTables();
    await this.loadAccounts();
  }

  async ensureTables() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_copilot_feedback (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        offset_account_id TEXT NOT NULL,
        reason TEXT,
        correction_count INTEGER DEFAULT 1,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(entity_id, fingerprint)
      );

      CREATE TABLE IF NOT EXISTS ai_copilot_suggestions (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        import_transaction_id TEXT,
        fitid TEXT,
        confidence_score NUMERIC(8,4) NOT NULL,
        status TEXT DEFAULT 'suggested',
        explanation TEXT,
        suggestion_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS ai_copilot_support_docs (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        import_transaction_id TEXT,
        fitid TEXT,
        doc_path TEXT NOT NULL,
        confidence_score NUMERIC(8,4) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  async loadAccounts() {
    const rows = await this.db.all(
      `SELECT id, account_number, account_name, account_type, normal_balance, is_active
       FROM accounts
       WHERE entity_id = ?`,
      [this.entityId]
    );
    this.accounts = rows || [];
    this.accountsById = new Map(this.accounts.map((a) => [a.id, a]));
    this.accountsByNumber = new Map(this.accounts.map((a) => [String(a.account_number), a]));
  }

  accountByIdOrNumber(value) {
    if (!value) return null;
    return this.accountsById.get(String(value)) || this.accountsByNumber.get(String(value)) || null;
  }

  findFirstByType(types) {
    const allowed = new Set(types);
    return this.accounts.find((a) => allowed.has(a.account_type) && Number(a.is_active ?? 1) !== 0) || null;
  }

  findByNumbers(accountNumbers) {
    for (const n of accountNumbers) {
      const account = this.accountsByNumber.get(String(n));
      if (account && Number(account.is_active ?? 1) !== 0) return account;
    }
    return null;
  }

  async feedbackForFingerprint(fingerprint) {
    return this.db.get(
      `SELECT * FROM ai_copilot_feedback
       WHERE entity_id = ? AND fingerprint = ?
       ORDER BY correction_count DESC, updated_at DESC
       LIMIT 1`,
      [this.entityId, fingerprint]
    );
  }

  chooseOffsetAccount({ amountCents, description, feedback }) {
    const reasons = [];
    let confidence = 0.5;

    if (feedback) {
      const learned = this.accountByIdOrNumber(feedback.offset_account_id);
      if (learned) {
        confidence += 0.35;
        reasons.push(`Used learned correction for fingerprint: ${feedback.fingerprint}.`);
        reasons.push(`Previous correction reason: ${feedback.reason || 'manual correction'}.`);
        return { account: learned, confidence: clampConfidence(confidence), reasons, source: 'learned-feedback' };
      }
      reasons.push('Learned rule exists but account no longer active; falling back to deterministic rules.');
      confidence -= 0.1;
    }

    const rules = amountCents >= 0 ? INFLOW_RULES : OUTFLOW_RULES;
    for (const rule of rules) {
      if (rule.pattern.test(description)) {
        const account = this.findByNumbers(rule.accountNumbers);
        if (account) {
          confidence += 0.25;
          reasons.push(rule.reason);
          return { account, confidence: clampConfidence(confidence), reasons, source: 'keyword-rule' };
        }
      }
    }

    if (amountCents >= 0) {
      const fallback = this.findFirstByType(['REVENUE', 'EQUITY', 'LIABILITY']);
      if (fallback) {
        confidence -= 0.05;
        reasons.push('No explicit inflow keyword matched; using first active revenue/equity/liability account.');
        return { account: fallback, confidence: clampConfidence(confidence), reasons, source: 'fallback-inflow' };
      }
    } else {
      const fallback = this.findFirstByType(['EXPENSE', 'ASSET', 'LIABILITY']);
      if (fallback) {
        confidence -= 0.05;
        reasons.push('No explicit outflow keyword matched; using first active expense/asset/liability account.');
        return { account: fallback, confidence: clampConfidence(confidence), reasons, source: 'fallback-outflow' };
      }
    }

    throw new Error('Unable to determine offset account (no active candidate accounts found).');
  }

  async buildSuggestion(txn) {
    const amountCents = toCents(txn.amount);
    if (amountCents === 0) throw new Error('Cannot suggest a zero-amount posting.');

    const bankAccount = this.accountByIdOrNumber(
      txn.account_id || txn.bank_account_id || txn.bankAccountId || txn.bankAccountNumber || txn.bank_account_number
    );
    if (!bankAccount) throw new Error('Bank account not found for transaction.');

    const description = String(txn.description || '').trim();
    const fingerprint = buildFingerprint({
      accountId: bankAccount.id,
      description,
      amountCents,
    });
    const feedback = await this.feedbackForFingerprint(fingerprint);
    const offset = this.chooseOffsetAccount({ amountCents, description, feedback });
    const absCents = Math.abs(amountCents);
    const postingDate = toIsoDay(txn.date || txn.posting_date || new Date().toISOString().slice(0, 10));
    const lines = amountCents >= 0
      ? [
          {
            role: 'bank',
            account_id: bankAccount.id,
            account_number: bankAccount.account_number,
            account_name: bankAccount.account_name,
            debit_cents: absCents,
            credit_cents: 0,
            rationale: 'Cash inflow increases bank asset (debit).',
          },
          {
            role: 'offset',
            account_id: offset.account.id,
            account_number: offset.account.account_number,
            account_name: offset.account.account_name,
            debit_cents: 0,
            credit_cents: absCents,
            rationale: `Offset selected by ${offset.source}.`,
          },
        ]
      : [
          {
            role: 'offset',
            account_id: offset.account.id,
            account_number: offset.account.account_number,
            account_name: offset.account.account_name,
            debit_cents: absCents,
            credit_cents: 0,
            rationale: `Offset selected by ${offset.source}.`,
          },
          {
            role: 'bank',
            account_id: bankAccount.id,
            account_number: bankAccount.account_number,
            account_name: bankAccount.account_name,
            debit_cents: 0,
            credit_cents: absCents,
            rationale: 'Cash outflow decreases bank asset (credit).',
          },
        ];

    assertBalanced(lines);

    const confidence = clampConfidence(offset.confidence);
    return {
      entity_id: this.entityId,
      import_transaction_id: txn.id || null,
      fitid: txn.fitid || null,
      posting_date: postingDate,
      description,
      amount_cents: amountCents,
      confidence_score: confidence,
      needs_review: confidence < this.confidenceThreshold,
      fingerprint,
      lines,
      explanation: [
        `Transaction direction: ${amountCents >= 0 ? 'inflow' : 'outflow'} (${centsToAmount(amountCents)}).`,
        `Bank account: ${bankAccount.account_number} · ${bankAccount.account_name}.`,
        `Offset account: ${offset.account.account_number} · ${offset.account.account_name}.`,
        ...offset.reasons,
        'Double-entry guard passed: sum(debits - credits) = 0 cents.',
      ],
    };
  }

  async getLatestSuggestionForImportTransaction(importTransactionId) {
    if (!importTransactionId) return null;
    const row = await this.db.get(
      `SELECT * FROM ai_copilot_suggestions
       WHERE entity_id = ? AND import_transaction_id = ?
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
      [this.entityId, importTransactionId]
    );
    if (!row) return null;
    return parseSuggestionJson(row.suggestion_json);
  }

  async suggestForImportTransaction(txn, { persist = true, forceRefresh = false } = {}) {
    if (!forceRefresh) {
      const cached = await this.getLatestSuggestionForImportTransaction(txn.id);
      if (cached) return cached;
    }
    const suggestion = await this.buildSuggestion(txn);
    if (persist) await this.persistSuggestion(suggestion);
    return suggestion;
  }

  async persistSuggestion(suggestion) {
    const explanationText = suggestion.explanation.join(' ');
    const existing = suggestion.import_transaction_id
      ? await this.db.get(
          `SELECT id FROM ai_copilot_suggestions
           WHERE entity_id = ? AND import_transaction_id = ?
           ORDER BY updated_at DESC, created_at DESC
           LIMIT 1`,
          [suggestion.entity_id, suggestion.import_transaction_id]
        )
      : null;

    const status = suggestion.needs_review ? 'needs_review' : 'suggested';
    if (existing?.id) {
      await this.db.run(
        `UPDATE ai_copilot_suggestions
         SET fitid = ?, confidence_score = ?, status = ?, explanation = ?, suggestion_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          suggestion.fitid,
          suggestion.confidence_score,
          status,
          explanationText,
          JSON.stringify(suggestion),
          existing.id,
        ]
      );
    } else {
      await this.db.run(
        `INSERT INTO ai_copilot_suggestions
         (id, entity_id, import_transaction_id, fitid, confidence_score, status, explanation, suggestion_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          `cop-sug-${uuidv4()}`,
          suggestion.entity_id,
          suggestion.import_transaction_id,
          suggestion.fitid,
          suggestion.confidence_score,
          status,
          explanationText,
          JSON.stringify(suggestion),
        ]
      );
    }

    const docPath = this.writeSupportDoc(suggestion);
    const existingDoc = suggestion.import_transaction_id
      ? await this.db.get(
          `SELECT id FROM ai_copilot_support_docs
           WHERE entity_id = ? AND import_transaction_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
          [suggestion.entity_id, suggestion.import_transaction_id]
        )
      : null;

    if (existingDoc?.id) {
      await this.db.run(
        `UPDATE ai_copilot_support_docs
         SET doc_path = ?, confidence_score = ?
         WHERE id = ?`,
        [docPath, suggestion.confidence_score, existingDoc.id]
      );
    } else {
      await this.db.run(
        `INSERT INTO ai_copilot_support_docs
         (id, entity_id, import_transaction_id, fitid, doc_path, confidence_score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          `cop-doc-${uuidv4()}`,
          suggestion.entity_id,
          suggestion.import_transaction_id,
          suggestion.fitid,
          docPath,
          suggestion.confidence_score,
        ]
      );
    }
  }

  async setSuggestionStatus(importTransactionId, status) {
    if (!importTransactionId || !status) return;
    await this.db.run(
      `UPDATE ai_copilot_suggestions
       SET status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE entity_id = ? AND import_transaction_id = ?`,
      [status, this.entityId, importTransactionId]
    );
  }

  writeSupportDoc(suggestion) {
    const day = new Date().toISOString().slice(0, 10);
    const docDir = path.join(SUPPORT_DOC_DIR, suggestion.entity_id, day);
    ensureDir(docDir);

    const key = suggestion.fitid || suggestion.import_transaction_id || `manual-${Date.now()}`;
    const filePath = path.join(docDir, `${String(key).replace(/[^a-zA-Z0-9_-]/g, '_')}.md`);
    const linesTable = suggestion.lines.map((line) => (
      `| ${line.role} | ${line.account_number} | ${line.account_name} | ${centsToAmount(line.debit_cents)} | ${centsToAmount(line.credit_cents)} | ${line.rationale} |`
    )).join('\n');

    const body = [
      '# AI Accounting Copilot Support Document',
      '',
      `- Entity: ${suggestion.entity_id}`,
      `- FITID: ${suggestion.fitid || 'n/a'}`,
      `- Import Transaction ID: ${suggestion.import_transaction_id || 'manual-preview'}`,
      `- Posting Date: ${suggestion.posting_date}`,
      `- Description: ${suggestion.description}`,
      `- Amount (cents): ${suggestion.amount_cents}`,
      `- Confidence Score: ${suggestion.confidence_score}`,
      `- Needs Review: ${suggestion.needs_review ? 'yes' : 'no'}`,
      '',
      '## Proposed Double Entry',
      '',
      '| Role | Account # | Account | Debit | Credit | Rationale |',
      '|---|---:|---|---:|---:|---|',
      linesTable,
      '',
      '## Why These Accounts',
      '',
      ...suggestion.explanation.map((line) => `- ${line}`),
      '',
      '## Verification Checklist',
      '',
      '- [ ] Description aligns with source bank statement',
      '- [ ] Offset account is appropriate for business purpose',
      '- [ ] Supporting document attached to transaction',
      '- [ ] Reviewer approved confidence threshold or manually corrected',
      '',
    ].join('\n');

    fs.writeFileSync(filePath, body, 'utf8');
    return filePath;
  }

  async learnCorrection({ fitid, offsetAccountRef, reason }) {
    const txn = await this.db.get(
      `SELECT id, fitid, account_id, amount, description
       FROM import_transactions
       WHERE entity_id = ? AND fitid = ?`,
      [this.entityId, fitid]
    );
    if (!txn) throw new Error(`Transaction not found for fitid: ${fitid}`);

    const offsetAccount = this.accountByIdOrNumber(offsetAccountRef);
    if (!offsetAccount) throw new Error(`Offset account not found: ${offsetAccountRef}`);

    const fingerprint = buildFingerprint({
      accountId: txn.account_id,
      description: txn.description,
      amountCents: toCents(txn.amount),
    });

    await this.db.run(
      `INSERT INTO ai_copilot_feedback
       (id, entity_id, fingerprint, offset_account_id, reason, correction_count, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(entity_id, fingerprint)
       DO UPDATE SET
         offset_account_id = excluded.offset_account_id,
         reason = excluded.reason,
         correction_count = ai_copilot_feedback.correction_count + 1,
         created_by = excluded.created_by,
         updated_at = CURRENT_TIMESTAMP`,
      [`cop-fb-${uuidv4()}`, this.entityId, fingerprint, offsetAccount.id, reason || 'manual correction', this.userId]
    );
  }
}
