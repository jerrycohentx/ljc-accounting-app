/**
 * Receipt Ingestion Service
 * =========================
 *
 * Single entry point for turning a raw document (from email scan, cloud sync,
 * WhatsApp bot, mobile scanner or manual upload) into a stored, parsed receipt.
 *
 * Guarantees:
 *  - Idempotent: a deterministic idempotency key prevents duplicate receipts
 *    when the same document is seen again (e.g. re-scanning an inbox).
 *  - PII-safe: only masked text is persisted (the parser masks before return).
 *  - Structured + scored: every receipt carries a confidence_score and is
 *    flagged for human review when below the threshold.
 */

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { parseReceipt } from './receipt-parser.js';

export function buildIdempotencyKey({ entityId, source, externalRef, rawText }) {
  const basis = externalRef
    ? `${entityId}|${source}|${externalRef}`
    : `${entityId}|${source}|${crypto.createHash('sha256').update(rawText || '').digest('hex')}`;
  return crypto.createHash('sha256').update(basis).digest('hex');
}

/**
 * Ingest a single document. Returns { status, receipt } where status is
 * 'created' or 'duplicate'.
 */
export async function ingestDocument(db, {
  entityId,
  userId,
  source,
  connectionId = null,
  externalRef = null,
  fileName = null,
  fileMime = null,
  rawText = '',
  fileData = null,
}) {
  if (!entityId) throw new Error('entityId required');
  if (!userId) throw new Error('userId required');
  if (!source) throw new Error('source required');

  const idempotencyKey = buildIdempotencyKey({ entityId, source, externalRef, rawText });

  const existing = await db.get(
    'SELECT * FROM receipts WHERE idempotency_key = ?',
    idempotencyKey
  );
  if (existing) {
    return { status: 'duplicate', receipt: existing };
  }

  const parsed = parseReceipt(rawText);
  const id = `rcpt-${uuidv4()}`;
  const status = parsed.needsReview ? 'PENDING_REVIEW' : 'REVIEWED';

  await db.run(
    `INSERT INTO receipts (
      id, entity_id, idempotency_key, source, source_connection_id,
      vendor, receipt_date, currency, subtotal_cents, tax_cents, total_cents,
      category, confidence_score, status, needs_review, raw_text,
      file_name, file_mime, file_data, external_ref, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      entityId,
      idempotencyKey,
      source,
      connectionId,
      parsed.vendor,
      parsed.receiptDate,
      parsed.currency,
      parsed.subtotalCents ?? 0,
      parsed.taxCents ?? 0,
      parsed.totalCents ?? 0,
      parsed.category,
      parsed.confidenceScore,
      status,
      parsed.needsReview ? 1 : 0,
      parsed.maskedText,
      fileName,
      fileMime,
      fileData,
      externalRef,
      userId,
    ]
  );

  const receipt = await db.get('SELECT * FROM receipts WHERE id = ?', id);
  return { status: 'created', receipt };
}
