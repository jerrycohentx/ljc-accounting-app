import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
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
  ? { origin: process.env.FRONTEND_URL || '*', credentials: true }
  : { origin: '*', credentials: true };

app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' })); // Increase limit for OFX file uploads
app.use(express.urlencoded({ limit: '50mb' }));

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

// Import and bank reconciliation routes (top level)
app.use('/api/import', importRoutes);
app.use('/api/reconciliation/bank', bankReconciliationRoutes);

// Entity-specific routes
app.use('/api/entities/:entityId/accounts', accountRoutes);
app.use('/api/entities/:entityId/journals', journalRoutes);
app.use('/api/entities/:entityId/ledger', ledgerRoutes);
app.use('/api/entities/:entityId/reports', reportsRoutes);
app.use('/api/entities/:entityId/reconciliations', reconciliationRoutes);

// Serve frontend in production
if (NODE_ENV === 'production') {
  const frontendPath = path.join(__dirname, 'frontend', 'dist');
  app.use(express.static(frontendPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
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

// Start server — listen first so Render health checks pass during DB init
async function start() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✓ Server running on http://localhost:${PORT}`);
    console.log(`✓ Database target: ${isPostgres() ? 'PostgreSQL (cloud)' : './db/accounting.db'}`);
    console.log('✓ API Endpoints ready');
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
