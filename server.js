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
import plaidRoutes, { plaidWebhookHandler } from './routes/plaid.js';
import holdbackDrawRoutes from './routes/holdback-draws.js';
import interestAccrualRoutes from './routes/interest-accrual.js';
import receiptRoutes, { whatsappWebhookHandler } from './routes/receipts.js';
import { authMiddleware } from './middleware/auth.js';

dotenv.config();

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

// Health check
app.get('/health', async (req, res) => {
  const payload = { status: 'ok', timestamp: new Date().toISOString() };
  try {
    const db = await getDatabase();
    const row = await db.get('SELECT COUNT(*) as count FROM users');
    payload.database = isPostgres() ? 'postgres' : 'sqlite';
    payload.users = Number(row?.count ?? 0);
  } catch (error) {
    payload.databaseError = error.message;
  }
  res.json(payload);
});

// Routes
app.use('/auth', authRoutes);

// Plaid webhook (no JWT — Plaid server calls this)
app.post('/api/plaid/webhook', plaidWebhookHandler);

// WhatsApp receipt-bot webhook (no JWT — secured by shared token)
app.post('/api/receipts/webhook/whatsapp', whatsappWebhookHandler);

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
app.use('/api/plaid', plaidRoutes);
app.use('/api/holdback-draws', holdbackDrawRoutes);
app.use('/api/receipts', receiptRoutes);
app.use('/api/reconciliation/bank', bankReconciliationRoutes);

// Entity-specific routes
app.use('/api/entities/:entityId/accounts', accountRoutes);
app.use('/api/entities/:entityId/journals', journalRoutes);
app.use('/api/entities/:entityId/ledger', ledgerRoutes);
app.use('/api/entities/:entityId/reports', reportsRoutes);
app.use('/api/entities/:entityId/interest-accrual', interestAccrualRoutes);
app.use('/api/entities/:entityId/reconciliations', reconciliationRoutes);

const frontendDistPath = path.join(__dirname, 'frontend', 'dist');
const frontendIndexPath = path.join(frontendDistPath, 'index.html');
const serveBuiltFrontend = NODE_ENV === 'production' || fs.existsSync(frontendIndexPath);

if (serveBuiltFrontend) {
  app.use(express.static(frontendDistPath));
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
    await getDatabase();
    console.log('✓ Database connected');
  } catch (error) {
    console.error('Database initialization failed:', error);
    process.exit(1);
  }
}

start();
