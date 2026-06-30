/**
 * ACH Interest JE Import Routes
 * =============================
 * Upload the monthly QBO_ACH_JE_<YYYY-MM>.csv produced by the loan-servicing app,
 * preview the resulting balanced journal entry, then post it to the ent-ljc GL.
 *
 *   POST /api/ach-je-import/preview { csvContent, fileName, entityId? }
 *   POST /api/ach-je-import/commit  { csvContent, fileName, entityId? }
 *
 * Mounted behind authMiddleware (see server.js).
 */

import express from 'express';
import { getDatabase } from '../config/database.js';
import { buildAchJePreview, commitAchJeImport, LJC_ENTITY_ID } from '../lib/ach-je-import.js';

const router = express.Router();

router.post('/preview', async (req, res) => {
  try {
    const { csvContent, fileName, entityId = LJC_ENTITY_ID } = req.body || {};
    if (!csvContent) return res.status(400).json({ error: 'csvContent required' });
    const db = await getDatabase();
    const preview = await buildAchJePreview(db, { csvText: csvContent, fileName, entityId });
    res.json(preview);
  } catch (error) {
    console.error('ACH JE preview failed:', error);
    res.status(400).json({ error: error.message });
  }
});

router.post('/commit', async (req, res) => {
  try {
    const { csvContent, fileName, entityId = LJC_ENTITY_ID } = req.body || {};
    if (!csvContent) return res.status(400).json({ error: 'csvContent required' });
    const db = await getDatabase();
    const result = await commitAchJeImport(db, {
      csvText: csvContent,
      fileName,
      entityId,
      userId: req.user?.id || 'usr-admin',
    });
    res.json(result);
  } catch (error) {
    console.error('ACH JE commit failed:', error);
    res.status(400).json({ error: error.message });
  }
});

export default router;
