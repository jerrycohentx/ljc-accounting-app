# LJC Accounting System

A QBO-style accounting application for LJC Financial and related entities. Full read-write accounting with multi-entity support, journal entries, financial reporting, and reconciliation.

## Quick Start

### 1. Backend Setup

```bash
# Install dependencies
npm install

# Initialize database (creates schema and default entities)
npm run db:init

# Start backend server
npm run dev
# Server runs at http://localhost:3000
```

### 2. Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm run dev
# Frontend runs at http://localhost:5173
```

### 3. Access the Application

- **URL**: http://localhost:5173
- **Demo Login**: 
  - Email: demo@ljcfinancial.com
  - Password: demo123

## Project Structure

```
ljc-accounting-app/
├── db/
│   ├── schema.sql          # SQLite database schema
│   └── accounting.db       # Database file (created after init)
├── config/
│   └── database.js         # Database connection config
├── middleware/
│   └── auth.js             # JWT authentication middleware
├── routes/
│   └── auth.js             # Authentication endpoints
├── scripts/
│   ├── init-db.js          # Database initialization
│   └── seed-db.js          # Sample data seeder
├── server.js               # Express server entry point
├── package.json
└── frontend/
    ├── src/
    │   ├── components/     # React components
    │   ├── pages/          # Page components
    │   ├── services/       # API services
    │   ├── App.jsx         # Main app component
    │   └── main.jsx        # React entry point
    ├── vite.config.js
    └── package.json
```

## API Endpoints (Phase 1)

### Authentication
- `POST /auth/login` - Login user
- `POST /auth/register` - Register new user
- `POST /auth/refresh` - Refresh JWT token

### Entities
- `GET /api/entities` - List all entities
- `GET /api/entities/:id` - Get entity details

### Protected Routes
All endpoints below require JWT authentication (Bearer token).

**Coming in Phase 2:**
- Chart of Accounts (CRUD)
- General Ledger (view, search)
- Journal Entries (CRUD, approval workflow)
- Financial Reports (P&L, Balance Sheet, Trial Balance)
- Reconciliation (intercompany, bank, etc.)

## Database Schema

**Core Tables:**
- `entities` - Companies (LJC, Justin, OMC, etc.)
- `users` - System users with role-based access
- `accounts` - Chart of accounts with hierarchy
- `journal_entries` - JE header with status workflow
- `journal_entry_lines` - JE line items with debit/credit
- `general_ledger` - Posted GL entries with running balance
- `reconciliations` - Intercompany and bank reconciliations
- `audit_logs` - Full audit trail of changes
- `sessions` - User session management

## Configuration

### Environment Variables (.env)
```
PORT=3000
NODE_ENV=development
JWT_SECRET=your-secret-key-change-in-production
DATABASE_URL=./db/accounting.db
```

### Frontend Environment (.env.example)
```
VITE_API_URL=http://localhost:3000
```

## Development Workflow

### Backend Development
- Backend runs at `http://localhost:3000`
- Use `npm run dev` for auto-reload with Nodemon
- API responses are JSON
- All errors include descriptive messages

### Frontend Development
- Frontend runs at `http://localhost:5173`
- Use `npm run dev` for hot reload
- Proxy configured to backend at /api and /auth routes
- Material-UI components for styling

## Phase Roadmap

**Phase 1 (Current): Foundation** ✓
- [x] Database schema & initialization
- [x] JWT authentication
- [x] Multi-entity support
- [x] Basic React setup with routing
- [ ] Demo user creation in db:seed
- [ ] Basic pages & navigation

**Phase 2: Core Accounting**
- Chart of Accounts (CRUD, hierarchy)
- Journal Entry workflow (draft → approve → post)
- General Ledger posting with double-entry validation
- Transaction search & filtering

**Phase 3: Reporting**
- P&L (Income Statement)
- Balance Sheet
- Trial Balance
- General Ledger reports
- Dashboard with KPIs

**Phase 4: Reconciliation & Workflows**
- Intercompany reconciliation (critical for LJC)
- Bank reconciliation
- Approval workflows
- Batch operations
- UI polish

**Phase 5: Deployment & Docs**
- Docker Compose setup
- API documentation (Swagger/OpenAPI)
- User guide
- Test suite

## Troubleshooting

### Database Issues
```bash
# Reset database and reinitialize
rm db/accounting.db
npm run db:init
```

### Backend won't start
- Check PORT 3000 is not in use: `lsof -i :3000`
- Verify Node.js version: `node --version` (requires v16+)
- Check .env file exists with JWT_SECRET set

### Frontend won't connect to backend
- Ensure backend is running: `curl http://localhost:3000/health`
- Check VITE_API_URL in frontend/.env
- Browser console for CORS errors

## Next Steps

1. Run `npm run db:init` in backend to create database
2. Create demo user in seed script
3. Build Chart of Accounts module (Phase 2)
4. Implement Journal Entry creation & GL posting
5. Add financial reports

## Support

For issues or questions, see the IMPLEMENTATION_PLAN.md for detailed architecture.
