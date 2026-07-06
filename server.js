import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { fileURLToPath } from 'url';
import { getDatabase, closeDatabase, isPostgres } from './config/database.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/accounts.js';
import journalRoutes from './routes/journals.js';
import ledgerRoutes from './routes/ledger.js';
import reportsRoutes from './routes/reports.js';
import reconciliationRoutes from './routes/reconciliation.js';
import importRoutes from './routes/import.js';
import bankReconciliationRoutes from './routes/reconciliation-bank.js';
import reconciliationReportsRoutes from './routes/reconciliation-reports.js';
import plaidRoutes, { plaidWebhookHandler } from './routes/plaid.js';
import receiptRoutes, { whatsappWebhookHandler } from './routes/receipts.js';
import holdbackDrawRoutes from './routes/holdback-draws.js';
import interestAccrualRoutes from './routes/interest-accrual.js';
import accountingOpsRoutes from './routes/accounting-ops.js';
import intercompanyRoutes from './routes/intercompany.js';
import taxFinancialsRoutes, { entityTaxRouter } from './routes/tax-financials.js';
import productionBootstrapRoutes from './routes/production-bootstrap.js';
import lonestarCatchupRoutes from './routes/lonestar-catchup.js';
import amexCatchupRoutes from './routes/amex-catchup.js';
import simmonsOfxCatchupRoutes from './routes/simmons-ofx-catchup.js';
import qboPlCatchupRoutes from './routes/qbo-pl-catchup.js';
import achJeImportRoutes from './routes/ach-je-import.js';
import automationRoutes, { buildPlatformHealthPayload } from './routes/automation.js';
import backupRoutes from './routes/backup.js';
import emailIngestRoutes from './routes/email-ingest.js';
import gmailOAuthRoutes, { gmailOAuthCallbackHandler } from './routes/gmail-oauth.js';
import { authMiddleware } from './middleware/auth.js';
import { startAutoBackup } from './lib/app-backup.js';
import { buildHealthPayload } from './lib/health-status.js';
import { startStatementAutoLoad, getStatementAutoLoadStatus, runStatementAutoLoad } from './lib/statement-auto-load.js';
import { removeDeprecatedRules } from './lib/categorization-rules.js';
import { startStatementEmailIngest, getStatementEmailIngestStatus } from './lib/statement-email-ingest.js';
import { startAchJeInboxScan } from './lib/ach-je-inbox-worker.js';
import { ingestLoanTrackerEvent } from './lib/loan-event-ingest.js';
import { loanTrackerKeyMiddleware } from './middleware/loan-tracker-auth.js';
import { syncAdminPhoneFromEnv } from './lib/user-phone.js';
import { ensurePlaywrightBrowsers, getPlaywrightBrowsersPath } from './lib/playwright-browsers.js';

dotenv.config();
getPlaywrightBrowsersPath();

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'ljc-accounting-secret-key-2026';
  console.warn('JWT_SECRET not set; using built-in default. Set JWT_SECRET in Render env for production.');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Middleware
const corsOptions = NODE_ENV === 'production'
  ? { origin: process.env.FRONTEND_URL || '*', credentials: true, allowedHeaders: ['Content-Type', 'Authorization', 'X-Loan-Tracker-Key'] }
  : { origin: '*', credentials: true, allowedHeaders: ['Content-Type', 'Authorization', 'X-Loan-Tracker-Key'] };

app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' })); // Increase limit for OFX file uploads
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

// Health check — full system status (loan tracker sidebar pattern)
app.get('/health', async (req, res) => {
  try {
    const db = await getDatabase();
    const emailIngest = await getStatementEmailIngestStatus(db);
    const row = await db.get('SELECT COUNT(*) as count FROM users');
    const payload = await buildHealthPayload({
      statementEmailIngest: emailIngest,
      users: Number(row?.count ?? 0),
    }, db);
    // Legacy flat fields for older clients
    payload.version = payload.app?.version;
    payload.gitSha = payload.app?.gitSha;
    payload.lastBackupAt = payload.backup?.lastBackupAt;
    res.json(payload);
  } catch (error) {
    const payload = await buildHealthPayload({ databaseError: error.message });
    res.json(payload);
  }
});

app.get('/api/automation/platform-health', async (req, res) => {
  try {
    const db = await getDatabase();
    res.json(await buildPlatformHealthPayload(db));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/automation/loan-events', loanTrackerKeyMiddleware, async (req, res) => {
  try {
    const db = await getDatabase();
    const result = await ingestLoanTrackerEvent(db, req.body || {});
    res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/automation/ach-je/import', loanTrackerKeyMiddleware, async (req, res) => {
  try {
    const { filename, content, csvContent, entityId = 'ent-ljc' } = req.body || {};
    const csvText = content || csvContent;
    if (!csvText) return res.status(400).json({ error: 'content or csvContent required' });
    const db = await getDatabase();
    const { commitAchJeImport } = await import('./lib/ach-je-import.js');
    const result = await commitAchJeImport(db, {
      csvText,
      fileName: filename,
      entityId,
      userId: 'loan-tracker-auto',
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Routes
app.use('/auth', authRoutes);

// Plaid webhook (no JWT — Plaid server calls this)
app.post('/api/plaid/webhook', plaidWebhookHandler);

// WhatsApp receipt-bot webhook (no JWT — secured by shared token)
app.post('/api/receipts/webhook/whatsapp', whatsappWebhookHandler);

// Gmail OAuth callback for bank statement email (no JWT — Google redirect)
app.get('/api/email/gmail/callback', gmailOAuthCallbackHandler);

// Production bootstrap (integration key — no JWT)
app.use('/api/production-bootstrap', productionBootstrapRoutes);
app.use('/api/lonestar-catchup', lonestarCatchupRoutes);
app.use('/api/amex-catchup', amexCatchupRoutes);
app.use('/api/simmons-ofx-catchup', simmonsOfxCatchupRoutes);
app.use('/api/qbo-pl-catchup', qboPlCatchupRoutes);

// Protected routes
app.use('/api', authMiddleware);

app.get('/api/entities', async (req, res) => {
  try {
    const db = await getDatabase();
    const entities = await db.all("SELECT id, name, code, type FROM entities WHERE status = 'ACTIVE'");
    res.json(entities);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Import, Plaid, holdback draws, and bank reconciliation routes (top level)
app.use('/api/import', importRoutes);
app.use('/api/ach-je-import', achJeImportRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/intercompany', intercompanyRoutes);
app.use('/api/tax-financials', taxFinancialsRoutes);
app.use('/api/plaid', plaidRoutes);
app.use('/api/receipts', receiptRoutes);
app.use('/api/holdback-draws', holdbackDrawRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/email/gmail', gmailOAuthRoutes);
app.use('/api/email/ingest', emailIngestRoutes);
app.use('/api/reconciliation/bank', bankReconciliationRoutes);
app.use('/api/reconciliation/reports', reconciliationReportsRoutes);

// Entity-specific routes
app.use('/api/entities/:entityId/accounts', accountRoutes);
app.use('/api/entities/:entityId/journals', journalRoutes);
app.use('/api/entities/:entityId/ledger', ledgerRoutes);
app.use('/api/entities/:entityId/reports', reportsRoutes);
app.use('/api/entities/:entityId/interest-accrual', interestAccrualRoutes);
app.use('/api/entities/:entityId/accounting', accountingOpsRoutes);
app.use('/api/entities/:entityId/reconciliations', reconciliationRoutes);
app.use('/api/entities/:entityId/tax-financials', entityTaxRouter);

const frontendDistPath = path.join(__dirname, 'frontend', 'dist');
const frontendIndexPath = path.join(frontendDistPath, 'index.html');
const serveBuiltFrontend = NODE_ENV === 'production' || fs.existsSync(frontendIndexPath);

if (serveBuiltFrontend) {
  app.use(express.static(frontendDistPath, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      } else if (filePath.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
  app.get('*', (req, res) => {
    res.sendFile(frontendIndexPath);
  });
  console.log('Serving frontend from frontend/dist');
}

// Error handling
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await closeDatabase();
  process.exit(0);
});

// Start server ΓÇö listen first so Render health checks pass during DB init
async function start() {
  const keyPath = path.join(__dirname, 'certs', 'key.pem');
  const certPath = path.join(__dirname, 'certs', 'cert.pem');
  const useHttps = fs.existsSync(keyPath) && fs.existsSync(certPath);
  console.log(`[https-check] useHttps=${useHttps} key=${keyPath}:${fs.existsSync(keyPath)} cert=${certPath}:${fs.existsSync(certPath)}`);
  const server = (useHttps
    ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
    : app
  ).listen(PORT, '0.0.0.0', () => {
    console.log(`✓ Server running on ${useHttps ? 'https' : 'http'}://localhost:${PORT}`);
    console.log(`✓ Database target: ${isPostgres() ? 'PostgreSQL (cloud)' : './db/accounting.db'}`);
    console.log('✓ API Endpoints ready');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Close the other process or use START-APP again.`);
      process.exit(1);
    }
    console.error('Server listen error:', err);
    process.exit(1);
  });

  try {
    const db = await getDatabase();
    console.log('✓ Database connected');
    ensurePlaywrightBrowsers().catch((err) => {
      console.warn('Playwright Chromium preload skipped:', err.message);
    });
    await syncAdminPhoneFromEnv(db);
    // Self-heal: remove the deprecated "Wire Transfer Debit" -> Lone Star (1001) rule that
    // contaminated the Lone Star bank account, BEFORE any statement auto-load runs.
    await removeDeprecatedRules(db).catch((e) => console.warn('Rule cleanup skipped:', e.message));
    startAutoBackup();
    startStatementAutoLoad(getDatabase);
    startStatementEmailIngest(getDatabase);
    startAchJeInboxScan(getDatabase);
  } catch (error) {
    console.error('Database initialization failed:', error);
    process.exit(1);
  }
}

start();
