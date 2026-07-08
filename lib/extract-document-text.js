/**
 * Extract readable text from emailed documents (PDF, plain text attachments, email body).
 * Bank-statement PDFs are detected and skipped so statement ingest keeps ownership.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const BANK_STATEMENT_MARKERS = [
  'CHECKING ACCOUNTS',
  'Current Balance',
  'Ending Balance',
  'Statement Dates',
  'Deposits and Additions',
  'CHECKS IN NUMBER ORDER',
  'Previous Balance',
];

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function looksLikeBankStatementText(text) {
  const hay = String(text || '');
  if (!hay) return false;
  let hits = 0;
  for (const marker of BANK_STATEMENT_MARKERS) {
    if (hay.includes(marker)) hits += 1;
  }
  return hits >= 2;
}

export async function extractTextFromPdfBuffer(buffer) {
  const parsed = await pdfParse(buffer);
  const text = (parsed.text || '').trim();
  if (!text) throw new Error('PDF contained no extractable text');
  if (looksLikeBankStatementText(text)) {
    throw new Error('bank statement PDF — handled by statement email ingest');
  }
  return text;
}

export async function extractTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  if (ext === '.pdf') return extractTextFromPdfBuffer(buf);
  if (/\.(txt|csv|eml)$/i.test(ext)) return buf.toString('utf8');
  throw new Error(`unsupported document type: ${ext || 'unknown'}`);
}

export async function extractTextFromAttachment({ filename, content, mimeType }) {
  const name = filename || 'attachment';
  const ext = path.extname(name).toLowerCase();
  const mime = String(mimeType || '').toLowerCase();

  if (ext === '.pdf' || mime.includes('pdf')) {
    return extractTextFromPdfBuffer(content);
  }
  if (/\.(txt|csv)$/i.test(ext) || mime.startsWith('text/')) {
    return content.toString('utf8');
  }

  // Images need OCR — use email subject/body context upstream when no text layer exists.
  if (/\.(jpe?g|png|gif|webp|tiff?|bmp|heic)$/i.test(ext) || mime.startsWith('image/')) {
    throw new Error('image attachment — no OCR text layer (use email body context)');
  }

  throw new Error(`unsupported attachment type: ${ext || mime || 'unknown'}`);
}

export function extractEmailBodyText(email) {
  const plain = String(email?.text || '').trim();
  if (plain.length > 20) return plain;
  const html = stripHtml(email?.html || '');
  return html;
}

export function emailBodyLooksLikeDocument(text) {
  const hay = String(text || '');
  if (hay.length < 15) return false;
  if (looksLikeBankStatementText(hay)) return false;
  if (/estatement|lone\s*star\s*bank|shellpoint/i.test(hay) && /statement/i.test(hay)) return false;
  return /\$[\d,]+\.\d{2}|\b\d{1,3}(?:,\d{3})+\.\d{2}\b/.test(hay);
}
