/**
 * Multi-entity dashboard summary.
 */

import express from 'express';
import { getDatabase } from '../config/database.js';
import { getEntitiesSummary } from '../lib/dashboard-entities.js';

const router = express.Router();

router.get('/entities-summary', async (req, res) => {
  try {
    const db = await getDatabase();
    const summary = await getEntitiesSummary(db);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
