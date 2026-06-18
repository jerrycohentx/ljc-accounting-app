# LJC Accounting App - Getting Started

## One-Time Setup

### Backend
```bash
# Navigate to app directory
cd ljc-accounting-app

# Install backend dependencies
npm install

# Initialize database (creates schema + default entities)
npm run db:init

# Seed database with demo user and chart of accounts
npm run db:seed
```

### Frontend
```bash
# Navigate to frontend
cd frontend

# Install frontend dependencies
npm install

# Copy environment file
cp .env.example .env
```

## Running the Application

### Start Backend (Terminal 1)
```bash
cd ljc-accounting-app
npm run dev
# Output: ✓ Server running on http://localhost:3000
#         ✓ Database at ./db/accounting.db
```

### Start Frontend (Terminal 2)
```bash
cd ljc-accounting-app/frontend
npm run dev
# Output: VITE v4.x.x  ready in xxx ms
#         ➜  Local:   http://localhost:5173/
```

### Access the App
- **URL**: http://localhost:5173
- **Login Email**: demo@ljcfinancial.com
- **Password**: demo123

## What's Ready (Phase 1)

✅ **Backend Foundation**
- SQLite database with complete accounting schema
- JWT authentication with multi-entity support
- Express API server with user roles (ADMIN, ACCOUNTANT, USER, VIEWER)
- Database initialization & seeding scripts
- Default entities: LJC, Justin, OMC, Graceful Meadows
- Default chart of accounts for LJC

✅ **Frontend Foundation**
- React + Vite with hot reload
- Material-UI components & styling
- Routing with protected pages
- Login/Register system
- Dashboard layout with sidebar navigation
- Entity & account listing
- API service layer with axios

✅ **Database**
- 9 core tables (entities, users, accounts, GL, journals, reconciliations, etc.)
- Audit logging infrastructure
- Multi-entity support with role-based access
- Foreign key constraints & indexes for performance

## Next Phase (Phase 2)

Phase 2 will add:
- Chart of Accounts full CRUD
- Journal Entry creation with draft → approve → post workflow
- General Ledger posting with double-entry validation
- Transaction search & filtering
- Account balance calculations

---

## Troubleshooting

**Database won't initialize**
```bash
# Delete existing DB and try again
rm db/accounting.db
npm run db:init
npm run db:seed
```

**Port 3000 already in use**
```bash
# Kill process using port 3000
lsof -i :3000
kill -9 <PID>
```

**Frontend can't connect to backend**
- Verify backend is running: `curl http://localhost:3000/health`
- Check frontend/.env has `VITE_API_URL=http://localhost:3000`
- Check browser console for CORS errors

**NPM dependencies issue**
```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install
```

---

Contact: For questions, refer to README.md and IMPLEMENTATION_PLAN.md
