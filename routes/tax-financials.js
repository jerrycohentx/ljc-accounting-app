import express from 'express';
import { getDatabase } from '../config/database.js';
import { entityAccessMiddleware } from '../middleware/auth.js';
import {
  buildTaxFinancialsPackage,
  buildAllEntitiesTaxPackage,
  taxPackageToCsv,
} from '../lib/tax-financials.js';

const router = express.Router();

// GET /api/tax-financials/:taxYear — all Cohen entities
router.get('/:taxYear', async (req, res) => {
  try {
    const taxYear = parseInt(req.params.taxYear, 10);
    if (Number.isNaN(taxYear)) return res.status(400).json({ error: 'Invalid tax year' });
    const db = await getDatabase();
    const pkg = await buildAllEntitiesTaxPackage(db, { taxYear });
    res.json(pkg);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/tax-financials/:taxYear/export.csv
router.get('/:taxYear/export.csv', async (req, res) => {
  try {
    const taxYear = parseInt(req.params.taxYear, 10);
    const db = await getDatabase();
    const pkg = await buildAllEntitiesTaxPackage(db, { taxYear });
    const sections = pkg.entities.map((e) => taxPackageToCsv(e)).join('\n\n---\n\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="tax-financials-${taxYear}.csv"`);
    res.send(sections);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

// Entity-scoped routes mounted separately
export const entityTaxRouter = express.Router({ mergeParams: true });

entityTaxRouter.get('/:taxYear', entityAccessMiddleware, async (req, res) => {
  try {
    const taxYear = parseInt(req.params.taxYear, 10);
    const db = await getDatabase();
    const pkg = await buildTaxFinancialsPackage(db, req.entityId, { taxYear });
    res.json(pkg);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

entityTaxRouter.get('/:taxYear/export.csv', entityAccessMiddleware, async (req, res) => {
  try {
    const taxYear = parseInt(req.params.taxYear, 10);
    const db = await getDatabase();
    const pkg = await buildTaxFinancialsPackage(db, req.entityId, { taxYear });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${req.entityId}-tax-${taxYear}.csv"`);
    res.send(taxPackageToCsv(pkg));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
