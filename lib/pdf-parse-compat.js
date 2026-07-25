/**
 * Compatible wrapper for pdf-parse v1 (function) and v2 (PDFParse class).
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfParseMod = require('pdf-parse');

/** @returns {Promise<string>} extracted text */
export async function parsePdfBuffer(buf) {
  if (typeof pdfParseMod === 'function') {
    const parsed = await pdfParseMod(buf);
    return parsed?.text || '';
  }
  if (pdfParseMod?.PDFParse) {
    const parser = new pdfParseMod.PDFParse({ data: buf });
    try {
      const result = await parser.getText();
      return result?.text || '';
    } finally {
      try { await parser.destroy?.(); } catch { /* ignore */ }
    }
  }
  throw new Error('pdf-parse module has no usable API');
}
