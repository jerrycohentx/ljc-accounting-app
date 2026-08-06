#!/usr/bin/env node
/**
 * Cohen Entities AI Accounting Copilot
 * ------------------------------------
 * Linear routine:
 *   [Import Statement] -> [Exact Match Check] -> [User Verification] -> [Flag & Post]
 *
 * Capabilities:
 *   - Suggest complete double-entry posting before save/post
 *   - Explain account choices
 *   - Assign confidence score
 *   - Learn from corrections
 *   - Generate supporting documentation
 *   - Monitor posted books for exceptions
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase, closeDatabase } from '../config/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SUPPORT_DOC_DIR = path.join(ROOT, 'logs', 'ai-copilot', 'support');
const EXCEPTION_DIR = path.join(ROOT, 'logs', 'ai-copilot', 'exceptions');
const DEFAULT_ENTITY_ID = process.env.COPILOT_ENTITY_ID || 'ent-ljc';
const DEFAULT_USER_ID = process.env.COPILOT_USER_ID || 'usr-admin';
const DEFAULT_THRESHOLD = Number(process.env.COPILOT_CONFIDENCE_THRESHOLD || 0.85);

const DAY_MS = 24 * 60 * 60 * 1000;

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

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

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
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t));
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

class AIAccountingCopilot {
  constructor(db, {
    entityId,
    userId = DEFAULT_USER_ID,
    confidenceThreshold = DEFAULT_THRESHOLD,
  }) {
    this.db = db;
    this.entityId = entityId || DEFAULT_ENTITY_ID;
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
      const acct = this.accountsByNumber.get(String(n));
      if (acct && Number(acct.is_active ?? 1) !== 0) return acct;
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
    if (amountCents === 0) {
      throw new Error('Cannot suggest a zero-amount posting.');
    }

    const bankAccount = this.accountByIdOrNumber(txn.account_id || txn.bank_account_id || txn.bankAccountId || txn.bankAccountNumber || txn.bank_account_number);
    if (!bankAccount) {
      throw new Error('Bank account not found for transaction.');
    }

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

    const explanation = [
      `Transaction direction: ${amountCents >= 0 ? 'inflow' : 'outflow'} (${centsToAmount(amountCents)}).`,
      `Bank account: ${bankAccount.account_number} · ${bankAccount.account_name}.`,
      `Offset account: ${offset.account.account_number} · ${offset.account.account_name}.`,
      ...offset.reasons,
      'Double-entry guard passed: sum(debits - credits) = 0 cents.',
    ];

    return {
      entity_id: this.entityId,
      import_transaction_id: txn.id || null,
      fitid: txn.fitid || null,
      posting_date: postingDate,
      description,
      amount_cents: amountCents,
      confidence_score: clampConfidence(offset.confidence),
      needs_review: clampConfidence(offset.confidence) < this.confidenceThreshold,
      fingerprint,
      lines,
      explanation,
    };
  }

  async persistSuggestion(suggestion) {
    const suggestionId = `cop-sug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const explanationText = suggestion.explanation.join(' ');

    await this.db.run(
      `INSERT INTO ai_copilot_suggestions
       (id, entity_id, import_transaction_id, fitid, confidence_score, status, explanation, suggestion_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        suggestionId,
        suggestion.entity_id,
        suggestion.import_transaction_id,
        suggestion.fitid,
        suggestion.confidence_score,
        suggestion.needs_review ? 'needs_review' : 'suggested',
        explanationText,
        JSON.stringify(suggestion),
      ]
    );

    const docPath = this.writeSupportDoc(suggestion);
    const docId = `cop-doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.db.run(
      `INSERT INTO ai_copilot_support_docs
       (id, entity_id, import_transaction_id, fitid, doc_path, confidence_score, created_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        docId,
        suggestion.entity_id,
        suggestion.import_transaction_id,
        suggestion.fitid,
        docPath,
        suggestion.confidence_score,
      ]
    );

    return { suggestionId, docPath };
  }

  writeSupportDoc(suggestion) {
    const day = new Date().toISOString().slice(0, 10);
    const docDir = path.join(SUPPORT_DOC_DIR, suggestion.entity_id, day);
    ensureDir(docDir);

    const key = suggestion.fitid || suggestion.import_transaction_id || `manual-${Date.now()}`;
    const filePath = path.join(docDir, `${String(key).replace(/[^a-zA-Z0-9_-]/g, '_')}.md`);
    const linesTable = suggestion.lines.map((l) => {
      return `| ${l.role} | ${l.account_number} | ${l.account_name} | ${centsToAmount(l.debit_cents)} | ${centsToAmount(l.credit_cents)} | ${l.rationale} |`;
    }).join('\n');

    const body = [
      `# AI Accounting Copilot Support Document`,
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
      `## Proposed Double Entry`,
      '',
      `| Role | Account # | Account | Debit | Credit | Rationale |`,
      `|---|---:|---|---:|---:|---|`,
      linesTable,
      '',
      `## Why These Accounts`,
      '',
      ...suggestion.explanation.map((line) => `- ${line}`),
      '',
      `## Verification Checklist`,
      '',
      `- [ ] Description aligns with source bank statement`,
      `- [ ] Offset account is appropriate for business purpose`,
      `- [ ] Supporting document attached to transaction`,
      `- [ ] Reviewer approved confidence threshold or manually corrected`,
      '',
    ].join('\n');

    fs.writeFileSync(filePath, body, 'utf8');
    return filePath;
  }

  async suggestByFitid(fitid, { persist = true } = {}) {
    const row = await this.db.get(
      `SELECT id, fitid, entity_id, account_id, date, amount, description, journal_entry_id, status
       FROM import_transactions
       WHERE entity_id = ? AND fitid = ?`,
      [this.entityId, fitid]
    );
    if (!row) {
      throw new Error(`Transaction not found for fitid: ${fitid}`);
    }
    const suggestion = await this.buildSuggestion(row);
    if (persist) await this.persistSuggestion(suggestion);
    return suggestion;
  }

  async suggestPending({ limit = 50, persist = true } = {}) {
    const rows = await this.db.all(
      `SELECT id, fitid, entity_id, account_id, date, amount, description, journal_entry_id, status
       FROM import_transactions
       WHERE entity_id = ? AND status IN ('DRAFT', 'MATCHED')
       ORDER BY date ASC, id ASC
       LIMIT ?`,
      [this.entityId, Number(limit)]
    );

    const results = [];
    for (const row of rows || []) {
      const suggestion = await this.buildSuggestion(row);
      if (persist) await this.persistSuggestion(suggestion);
      results.push(suggestion);
    }
    return results;
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

    const rowId = `cop-fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
      [rowId, this.entityId, fingerprint, offsetAccount.id, reason || 'manual correction', this.userId]
    );

    return {
      fitid,
      fingerprint,
      offset_account_id: offsetAccount.id,
      offset_account_number: offsetAccount.account_number,
      reason: reason || 'manual correction',
    };
  }

  async monitorBooks({ days = 30 } = {}) {
    const sinceDate = new Date(Date.now() - Number(days) * DAY_MS).toISOString().slice(0, 10);
    const staleDraftDate = new Date(Date.now() - 3 * DAY_MS).toISOString().slice(0, 10);
    const exceptions = [];

    const unbalanced = await this.db.all(
      `SELECT id, je_number, posting_date, total_debit, total_credit
       FROM journal_entries
       WHERE entity_id = ? AND status = 'POSTED' AND posting_date >= ?
         AND ABS(COALESCE(total_debit, 0) - COALESCE(total_credit, 0)) > 0.004`,
      [this.entityId, sinceDate]
    );
    for (const row of unbalanced || []) {
      exceptions.push({
        type: 'unbalanced-posted-journal',
        severity: 'high',
        reference: row.je_number || row.id,
        message: `Posted journal is out of balance (DR ${row.total_debit} vs CR ${row.total_credit}).`,
        posting_date: row.posting_date,
      });
    }

    const staleDrafts = await this.db.all(
      `SELECT id, fitid, date, amount, description
       FROM import_transactions
       WHERE entity_id = ? AND status = 'DRAFT' AND date <= ?
       ORDER BY date ASC`,
      [this.entityId, staleDraftDate]
    );
    for (const row of staleDrafts || []) {
      exceptions.push({
        type: 'stale-draft-import',
        severity: 'medium',
        reference: row.fitid || row.id,
        message: 'Draft import transaction has not been reviewed/posted.',
        date: row.date,
        amount: row.amount,
      });
    }

    const lowConfidence = await this.db.all(
      `SELECT fitid, import_transaction_id, confidence_score, status, created_at
       FROM ai_copilot_suggestions
       WHERE entity_id = ? AND created_at >= ? AND confidence_score < ?
         AND status IN ('suggested', 'needs_review', 'flagged', 'posted')
       ORDER BY created_at DESC`,
      [this.entityId, sinceDate, this.confidenceThreshold]
    );
    for (const row of lowConfidence || []) {
      exceptions.push({
        type: 'low-confidence-suggestion',
        severity: 'medium',
        reference: row.fitid || row.import_transaction_id,
        message: `Low-confidence suggestion (${row.confidence_score}) remains unresolved.`,
      });
    }

    const missingDocs = await this.db.all(
      `SELECT it.id, it.fitid, it.date, it.amount
       FROM import_transactions it
       LEFT JOIN ai_copilot_support_docs docs
         ON docs.entity_id = it.entity_id
        AND docs.import_transaction_id = it.id
       WHERE it.entity_id = ? AND it.status IN ('MATCHED', 'RECONCILED') AND it.date >= ?
         AND docs.id IS NULL`,
      [this.entityId, sinceDate]
    );
    for (const row of missingDocs || []) {
      exceptions.push({
        type: 'missing-support-documentation',
        severity: 'low',
        reference: row.fitid || row.id,
        message: 'Matched/reconciled transaction has no copilot support document.',
      });
    }

    const duplicateCandidates = await this.db.all(
      `SELECT date, amount, description, COUNT(*) AS duplicate_count
       FROM import_transactions
       WHERE entity_id = ? AND date >= ?
       GROUP BY date, amount, description
       HAVING COUNT(*) > 1`,
      [this.entityId, sinceDate]
    );
    for (const row of duplicateCandidates || []) {
      exceptions.push({
        type: 'possible-duplicate-import',
        severity: 'medium',
        reference: `${row.date}|${row.amount}`,
        message: `Detected ${row.duplicate_count} similar import rows with same date/amount/description.`,
      });
    }

    const report = {
      generated_at: new Date().toISOString(),
      entity_id: this.entityId,
      window_start: sinceDate,
      exception_count: exceptions.length,
      exceptions,
    };

    ensureDir(EXCEPTION_DIR);
    const filePath = path.join(EXCEPTION_DIR, `${this.entityId}-${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8');
    return { report, filePath };
  }
}

function printHelp() {
  console.log(`
Cohen Entities AI Accounting Copilot

Usage:
  node scripts/ai-accounting-copilot.mjs <command> [--options]

Commands:
  preview   Suggest posting for a single transaction payload (no DB row needed)
  suggest   Suggest posting for one imported transaction by fitid
  queue     Suggest postings for pending imported transactions
  learn     Record a manual correction so copilot learns account choice
  monitor   Run exception monitoring after posting
  watch     Continuously run monitor in intervals

Common options:
  --entity <entityId>              Default: ${DEFAULT_ENTITY_ID}
  --threshold <0-1>                Default: ${DEFAULT_THRESHOLD}
  --user <userId>                  Default: ${DEFAULT_USER_ID}

preview options:
  --bank-account-id <id> OR --bank-account-number <num>
  --date <YYYY-MM-DD>
  --amount <signed decimal>        Positive=inflow, negative=outflow
  --description "<memo text>"

suggest options:
  --fitid <fitid>

queue options:
  --limit <n>                      Default: 50

learn options:
  --fitid <fitid>
  --offset-account <id-or-number>
  --reason "<why corrected>"

monitor options:
  --days <n>                       Default: 30

watch options:
  --days <n>                       Default: 30
  --interval-seconds <n>           Default: 300
`);
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === 'help' || args.help) {
    printHelp();
    return;
  }

  const entityId = args.entity || DEFAULT_ENTITY_ID;
  const threshold = Number(args.threshold || DEFAULT_THRESHOLD);
  const userId = args.user || DEFAULT_USER_ID;
  const db = await getDatabase();
  const copilot = new AIAccountingCopilot(db, {
    entityId,
    userId,
    confidenceThreshold: threshold,
  });
  await copilot.init();

  if (command === 'preview') {
    const amount = args.amount;
    const date = args.date;
    const description = args.description;
    const bankRef = args['bank-account-id'] || args['bank-account-number'];
    if (!amount || !date || !description || !bankRef) {
      throw new Error('preview requires --amount, --date, --description, and bank account id/number.');
    }
    const suggestion = await copilot.buildSuggestion({
      account_id: args['bank-account-id'],
      bankAccountNumber: args['bank-account-number'],
      date,
      amount,
      description,
      fitid: `preview-${Date.now()}`,
    });
    const persisted = await copilot.persistSuggestion(suggestion);
    console.log(JSON.stringify({ suggestion, support_document: persisted.docPath }, null, 2));
    return;
  }

  if (command === 'suggest') {
    if (!args.fitid) throw new Error('suggest requires --fitid.');
    const suggestion = await copilot.suggestByFitid(args.fitid, { persist: true });
    console.log(JSON.stringify(suggestion, null, 2));
    return;
  }

  if (command === 'queue') {
    const limit = Number(args.limit || 50);
    const suggestions = await copilot.suggestPending({ limit, persist: true });
    const summary = {
      processed: suggestions.length,
      needs_review: suggestions.filter((s) => s.needs_review).length,
      ready_to_flag_post: suggestions.filter((s) => !s.needs_review).length,
      threshold,
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (command === 'learn') {
    if (!args.fitid || !args['offset-account']) {
      throw new Error('learn requires --fitid and --offset-account (account id or number).');
    }
    const learned = await copilot.learnCorrection({
      fitid: args.fitid,
      offsetAccountRef: args['offset-account'],
      reason: args.reason,
    });
    console.log(JSON.stringify({ learned }, null, 2));
    return;
  }

  if (command === 'monitor') {
    const days = Number(args.days || 30);
    const result = await copilot.monitorBooks({ days });
    console.log(JSON.stringify({
      report_file: result.filePath,
      exception_count: result.report.exception_count,
      exceptions: result.report.exceptions,
    }, null, 2));
    return;
  }

  if (command === 'watch') {
    const days = Number(args.days || 30);
    const intervalSec = Number(args['interval-seconds'] || 300);
    console.log(`Watching exceptions for entity ${entityId} every ${intervalSec}s...`);
    while (true) {
      const result = await copilot.monitorBooks({ days });
      console.log(`[${new Date().toISOString()}] exceptions=${result.report.exception_count} file=${result.filePath}`);
      await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
    }
  }

  throw new Error(`Unknown command: ${command}`);
}

main()
  .catch((err) => {
    console.error(`AI Copilot script failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
