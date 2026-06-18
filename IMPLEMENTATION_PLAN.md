# QBO-Style Accounting Web Application - Implementation Plan

**Document Version:** 1.0  
**Target Scope:** MVP (3-4 month development)  
**Technology Stack:** React/TypeScript, Node.js/Express, SQLite → Postgres migration path

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Data Model & Database Schema](#data-model--database-schema)
3. [System Architecture](#system-architecture)
4. [API Specification](#api-specification)
5. [Frontend Structure](#frontend-structure)
6. [Implementation Phases](#implementation-phases)
7. [Critical Path & Dependencies](#critical-path--dependencies)
8. [File Structure & Naming Conventions](#file-structure--naming-conventions)
9. [Key Architectural Decisions](#key-architectural-decisions)
10. [Deployment Strategy](#deployment-strategy)

---

## Project Overview

### MVP Features

**Multi-Entity & Organization**
- Support for multiple entities (LJC, Justin, OMC, etc.)
- Multi-user role-based access (Admin, Accountant, Viewer)
- Entity-scoped data isolation

**Core Accounting**
- Chart of Accounts (hierarchical, standard GL structure)
- General Ledger with drill-down capability
- Journal Entry creation/editing with approval workflow
- Transaction management with multi-line support

**Financial Reporting**
- Profit & Loss (income statement)
- Balance Sheet
- Trial Balance
- Reconciliation reports

**Data Management**
- Beancount import on startup
- Full audit trail (who, what, when, why)
- Reconciliation module for account balancing

**User Experience**
- Dashboard with key metrics (cash position, A/R, A/P, net income)
- Professional QBO-inspired UI
- Mobile-responsive design
- Real-time validation and error feedback

---

## Data Model & Database Schema

### Entity Relationship Diagram

```
entities (tenants)
├── chart_of_accounts
├── accounts
├── general_ledger (transactions)
├── journal_entries
├── journal_entry_lines
├── reconciliations
├── reconciliation_items
├── users
├── user_roles
├── audit_logs
├── document_attachments
└── import_logs
```

### Detailed Schema

#### 1. `entities` (Multi-tenancy)
```sql
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  legal_name VARCHAR(255),
  entity_type ENUM('LLC', 'S-CORP', 'C-CORP', 'SOLE_PROPRIETOR', 'PARTNERSHIP') NOT NULL,
  fiscal_year_end DATE,
  currency_code VARCHAR(3) DEFAULT 'USD',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES users(id),
  UNIQUE(name)
);
```

#### 2. `users` & `user_roles`
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  last_login TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  mfa_enabled BOOLEAN DEFAULT false,
  mfa_secret VARCHAR(255)
);

CREATE TABLE user_entity_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role ENUM('ADMIN', 'ACCOUNTANT', 'VIEWER') NOT NULL,
  permissions JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, entity_id)
);
```

#### 3. `chart_of_accounts`
```sql
CREATE TABLE chart_of_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  account_number VARCHAR(50) NOT NULL,
  account_name VARCHAR(255) NOT NULL,
  account_type ENUM(
    'ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE',
    'GAIN', 'LOSS', 'CONTRA_ASSET', 'CONTRA_LIABILITY', 'CONTRA_EQUITY'
  ) NOT NULL,
  account_class ENUM('CURRENT_ASSET', 'FIXED_ASSET', 'OTHER_ASSET', 
                      'CURRENT_LIABILITY', 'LONG_TERM_LIABILITY',
                      'INCOME', 'COST_OF_GOODS_SOLD', 'OPERATING_EXPENSE',
                      'OWNER_EQUITY') NOT NULL,
  parent_account_id UUID REFERENCES chart_of_accounts(id),
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  normal_balance ENUM('DEBIT', 'CREDIT') NOT NULL,
  allow_posting BOOLEAN DEFAULT true,
  allow_transactions_before DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES users(id),
  UNIQUE(entity_id, account_number)
);
```

#### 4. `general_ledger` (Core transaction table)
```sql
CREATE TABLE general_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  journal_entry_id UUID REFERENCES journal_entries(id),
  transaction_date DATE NOT NULL,
  posting_date DATE NOT NULL,
  description VARCHAR(500),
  reference_number VARCHAR(100),
  debit_amount DECIMAL(18, 2) DEFAULT 0,
  credit_amount DECIMAL(18, 2) DEFAULT 0,
  balance_after DECIMAL(18, 2),
  is_reconciled BOOLEAN DEFAULT false,
  reconciliation_id UUID REFERENCES reconciliations(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES users(id),
  INDEX idx_entity_account (entity_id, account_id),
  INDEX idx_transaction_date (transaction_date),
  INDEX idx_posting_date (posting_date)
);
```

#### 5. `journal_entries`
```sql
CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  posting_date DATE,
  entry_number VARCHAR(100) NOT NULL,
  description VARCHAR(500),
  memo TEXT,
  status ENUM('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REJECTED', 'VOID') DEFAULT 'DRAFT',
  reference_document VARCHAR(255),
  attachment_id UUID REFERENCES document_attachments(id),
  total_debit DECIMAL(18, 2) DEFAULT 0,
  total_credit DECIMAL(18, 2) DEFAULT 0,
  is_balanced BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by UUID REFERENCES users(id),
  approved_at TIMESTAMP,
  approved_by UUID REFERENCES users(id),
  posted_at TIMESTAMP,
  posted_by UUID REFERENCES users(id),
  created_at_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(entity_id, entry_number),
  INDEX idx_entity_date (entity_id, entry_date)
);

CREATE TABLE journal_entry_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_number INT NOT NULL,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  description VARCHAR(500),
  debit DECIMAL(18, 2) DEFAULT 0,
  credit DECIMAL(18, 2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_journal_entry (journal_entry_id),
  INDEX idx_account_id (account_id)
);
```

#### 6. `reconciliations`
```sql
CREATE TABLE reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  reconciliation_date DATE NOT NULL,
  statement_balance DECIMAL(18, 2) NOT NULL,
  book_balance DECIMAL(18, 2) NOT NULL,
  reconciled_balance DECIMAL(18, 2),
  status ENUM('IN_PROGRESS', 'RECONCILED', 'UNRECONCILED') DEFAULT 'IN_PROGRESS',
  variance DECIMAL(18, 2),
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  started_by UUID REFERENCES users(id),
  completed_by UUID REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reconciliation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id UUID NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
  gl_entry_id UUID NOT NULL REFERENCES general_ledger(id),
  is_matched BOOLEAN DEFAULT false,
  matched_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### 7. `document_attachments`
```sql
CREATE TABLE document_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  file_name VARCHAR(500) NOT NULL,
  file_path VARCHAR(1000) NOT NULL,
  file_size INT,
  file_type VARCHAR(50),
  upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### 8. `audit_logs`
```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID REFERENCES entities(id),
  user_id UUID REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100) NOT NULL,
  resource_id UUID,
  old_values JSONB,
  new_values JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_entity_timestamp (entity_id, timestamp),
  INDEX idx_user_timestamp (user_id, timestamp)
);
```

#### 9. `import_logs`
```sql
CREATE TABLE import_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  import_type ENUM('BEANCOUNT', 'CSV', 'QBO') NOT NULL,
  file_name VARCHAR(500),
  status ENUM('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED') DEFAULT 'PENDING',
  total_records INT DEFAULT 0,
  imported_records INT DEFAULT 0,
  failed_records INT DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  started_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Key Schema Decisions

- **UUID for PKs**: Better for distributed systems and migrations
- **JSONB for audit_logs**: Flexible schema for capturing any changes
- **Entity-scoped isolation**: All tables include `entity_id` for multi-tenancy
- **Audit trail**: `created_by`, `updated_at`, `audit_logs` table
- **Status enums**: Allow workflow management and soft-deletes via status
- **Indexes on common queries**: Entity/date combinations, timestamps
- **Double-entry bookkeeping**: Debit/credit balance enforced at application level

---

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (React/TS)                      │
│  Dashboard │ COA │ GL │ Journal Entry │ Reports │ Reconcile │
└──────────────────────────────────┬──────────────────────────┘
                                   │ (HTTP/REST)
┌──────────────────────────────────▼──────────────────────────┐
│                  API Layer (Express/Node)                   │
│  Routes │ Controllers │ Services │ Middleware               │
└──────────────────────────────────┬──────────────────────────┘
                                   │ (SQL)
┌──────────────────────────────────▼──────────────────────────┐
│              Data Layer (SQLite/Postgres)                   │
│  Models │ Migrations │ Repositories                         │
└─────────────────────────────────────────────────────────────┘
```

### Core Domains

**1. Entity Management**
- Multi-entity context switching
- Entity configuration & settings
- User-entity role assignment

**2. Chart of Accounts**
- Hierarchical account structure
- Account metadata (type, class, normal balance)
- Account activation/deactivation

**3. Transactions & Journaling**
- Journal entry creation and validation
- Automatic GL posting
- Entry status workflow (Draft → Pending → Posted)

**4. Reporting Engine**
- P&L generation
- Balance Sheet assembly
- Trial Balance verification
- Account-level detail drill-down

**5. Reconciliation**
- Account reconciliation workflow
- Matching transactions to statements
- Variance analysis

**6. Security & Audit**
- User authentication (JWT + session)
- Role-based access control (RBAC)
- Full audit trail logging

---

## API Specification

### Authentication Endpoints

```
POST   /api/auth/register              Register new user
POST   /api/auth/login                 Login (returns JWT + refresh token)
POST   /api/auth/refresh               Refresh JWT
POST   /api/auth/logout                Logout (invalidate token)
POST   /api/auth/mfa/setup             Setup MFA
POST   /api/auth/mfa/verify            Verify MFA code
```

### Entity Endpoints

```
GET    /api/entities                   List all entities (user has access to)
POST   /api/entities                   Create new entity
GET    /api/entities/:entityId          Get entity details
PUT    /api/entities/:entityId          Update entity
DELETE /api/entities/:entityId          Soft-delete entity
POST   /api/entities/:entityId/switch   Switch active entity (sets session)
```

### Chart of Accounts Endpoints

```
GET    /api/entities/:entityId/coa              List all accounts
GET    /api/entities/:entityId/coa/hierarchy    Get hierarchical structure
POST   /api/entities/:entityId/coa              Create new account
GET    /api/entities/:entityId/coa/:accountId   Get account details
PUT    /api/entities/:entityId/coa/:accountId   Update account
DELETE /api/entities/:entityId/coa/:accountId   Soft-delete account
POST   /api/entities/:entityId/coa/import       Bulk import from Beancount
```

### General Ledger Endpoints

```
GET    /api/entities/:entityId/gl                List GL entries (paginated)
GET    /api/entities/:entityId/gl/search         Search GL entries
GET    /api/entities/:entityId/gl/:glId          Get specific GL entry
GET    /api/entities/:entityId/accounts/:acctId/gl  Get GL for single account
POST   /api/entities/:entityId/gl/export         Export GL to CSV
```

### Journal Entry Endpoints

```
GET    /api/entities/:entityId/journals                 List journal entries
POST   /api/entities/:entityId/journals                 Create new entry
GET    /api/entities/:entityId/journals/:journalId      Get entry details
PUT    /api/entities/:entityId/journals/:journalId      Update entry (draft only)
DELETE /api/entities/:entityId/journals/:journalId      Delete entry (draft only)
POST   /api/entities/:entityId/journals/:journalId/post Post entry to GL
POST   /api/entities/:entityId/journals/:journalId/approve Approve entry
POST   /api/entities/:entityId/journals/:journalId/reject Reject entry
POST   /api/entities/:entityId/journals/batch           Create multiple entries
GET    /api/entities/:entityId/journals/:journalId/validate Validate entry balance
```

### Reports Endpoints

```
GET    /api/entities/:entityId/reports/pnl              P&L statement
GET    /api/entities/:entityId/reports/balance-sheet    Balance sheet
GET    /api/entities/:entityId/reports/trial-balance    Trial balance
GET    /api/entities/:entityId/reports/account-detail   Account detail report
GET    /api/entities/:entityId/reports/cash-flow        Cash flow forecast
GET    /api/entities/:entityId/reports/export           Export report (PDF/Excel)
```

### Reconciliation Endpoints

```
GET    /api/entities/:entityId/reconciliations              List reconciliations
POST   /api/entities/:entityId/reconciliations              Start reconciliation
GET    /api/entities/:entityId/reconciliations/:reconId     Get reconciliation details
PUT    /api/entities/:entityId/reconciliations/:reconId     Update reconciliation
POST   /api/entities/:entityId/reconciliations/:reconId/match Match GL item
POST   /api/entities/:entityId/reconciliations/:reconId/complete Complete reconciliation
GET    /api/entities/:entityId/reconciliations/:reconId/variance Get variance analysis
```

### Dashboard/Analytics Endpoints

```
GET    /api/entities/:entityId/dashboard/kpis    Key metrics
GET    /api/entities/:entityId/dashboard/cash    Cash position
GET    /api/entities/:entityId/dashboard/ar      A/R summary
GET    /api/entities/:entityId/dashboard/ap      A/P summary
GET    /api/entities/:entityId/dashboard/trends  Financial trends
```

### User & Access Endpoints

```
GET    /api/users/me                           Current user info
PUT    /api/users/me                           Update user profile
GET    /api/users/me/entities                   User's accessible entities
POST   /api/entities/:entityId/users            Add user to entity
PUT    /api/entities/:entityId/users/:userId    Update user role
DELETE /api/entities/:entityId/users/:userId    Remove user from entity
GET    /api/entities/:entityId/users            List users with access
```

### Audit & Settings Endpoints

```
GET    /api/entities/:entityId/audit-log                 Audit trail
GET    /api/entities/:entityId/settings                  Entity settings
PUT    /api/entities/:entityId/settings                  Update settings
GET    /api/entities/:entityId/import-log                Import history
POST   /api/entities/:entityId/import/beancount          Import Beancount file
```

### Request/Response Format

**Authentication Header**
```
Authorization: Bearer <jwt_token>
X-Entity-ID: <uuid>  // Current entity context
```

**Success Response (200)**
```json
{
  "success": true,
  "data": { /* resource or array */ },
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "pages": 8
  }
}
```

**Error Response (4xx/5xx)**
```json
{
  "success": false,
  "error": {
    "code": "ACCOUNT_NOT_FOUND",
    "message": "Account with ID xyz not found",
    "details": { /* optional */ }
  }
}
```

---

## Frontend Structure

### Technology Stack

- **Framework**: React 18+ (TypeScript)
- **State Management**: Redux Toolkit or Zustand
- **Form Handling**: React Hook Form + Zod validation
- **HTTP Client**: Axios with interceptors
- **UI Components**: Material-UI (MUI) or shadcn/ui + Tailwind
- **Charts**: Recharts or Chart.js
- **Table**: TanStack Table (React Table)
- **Router**: React Router v6
- **Build**: Vite
- **Testing**: Vitest + React Testing Library

### Directory Structure

```
frontend/
├── src/
│   ├── api/                          # API client & hooks
│   │   ├── client.ts                 # Axios instance with interceptors
│   │   ├── hooks/
│   │   │   ├── useAuth.ts
│   │   │   ├── useEntity.ts
│   │   │   ├── useJournalEntries.ts
│   │   │   ├── useChartOfAccounts.ts
│   │   │   ├── useGeneralLedger.ts
│   │   │   └── useReports.ts
│   │   └── services/
│   │       ├── authService.ts
│   │       ├── entityService.ts
│   │       ├── coaService.ts
│   │       ├── glService.ts
│   │       ├── journalService.ts
│   │       ├── reportService.ts
│   │       └── reconciliationService.ts
│   │
│   ├── store/                        # Redux Toolkit
│   │   ├── index.ts
│   │   ├── slices/
│   │   │   ├── authSlice.ts
│   │   │   ├── entitySlice.ts
│   │   │   ├── uiSlice.ts
│   │   │   └── settingsSlice.ts
│   │   └── middleware/
│   │       └── entityMiddleware.ts
│   │
│   ├── hooks/                        # Custom React hooks
│   │   ├── useDebounce.ts
│   │   ├── useLocalStorage.ts
│   │   ├── usePagination.ts
│   │   └── useAsync.ts
│   │
│   ├── components/                   # Reusable UI components
│   │   ├── common/
│   │   │   ├── Layout.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   ├── Header.tsx
│   │   │   ├── Footer.tsx
│   │   │   ├── Breadcrumb.tsx
│   │   │   ├── DataTable.tsx
│   │   │   └── Loading.tsx
│   │   ├── forms/
│   │   │   ├── AccountForm.tsx
│   │   │   ├── JournalEntryForm.tsx
│   │   │   ├── EntityForm.tsx
│   │   │   └── ReconciliationForm.tsx
│   │   ├── charts/
│   │   │   ├── PnLChart.tsx
│   │   │   ├── CashFlowChart.tsx
│   │   │   └── TrendChart.tsx
│   │   └── modals/
│   │       ├── ConfirmDialog.tsx
│   │       ├── ImportModal.tsx
│   │       └── ExportModal.tsx
│   │
│   ├── pages/                        # Route pages
│   │   ├── Auth/
│   │   │   ├── LoginPage.tsx
│   │   │   ├── RegisterPage.tsx
│   │   │   └── MFASetupPage.tsx
│   │   ├── Dashboard/
│   │   │   ├── DashboardPage.tsx
│   │   │   └── KPISummary.tsx
│   │   ├── ChartOfAccounts/
│   │   │   ├── CoaPage.tsx
│   │   │   ├── AccountDetailPage.tsx
│   │   │   └── AccountFormPage.tsx
│   │   ├── GeneralLedger/
│   │   │   ├── GlPage.tsx
│   │   │   ├── GlDetailPage.tsx
│   │   │   └── GlSearchPage.tsx
│   │   ├── JournalEntries/
│   │   │   ├── JournalPage.tsx
│   │   │   ├── JournalDetailPage.tsx
│   │   │   └── JournalFormPage.tsx
│   │   ├── Reports/
│   │   │   ├── ReportsPage.tsx
│   │   │   ├── PnLPage.tsx
│   │   │   ├── BalanceSheetPage.tsx
│   │   │   ├── TrialBalancePage.tsx
│   │   │   └── ExportPage.tsx
│   │   ├── Reconciliation/
│   │   │   ├── ReconciliationPage.tsx
│   │   │   ├── AccountReconcilePage.tsx
│   │   │   └── ReconciliationHistoryPage.tsx
│   │   ├── Settings/
│   │   │   ├── SettingsPage.tsx
│   │   │   ├── EntitySettingsPage.tsx
│   │   │   ├── UserManagementPage.tsx
│   │   │   └── AuditLogPage.tsx
│   │   ├── NotFoundPage.tsx
│   │   └── ErrorPage.tsx
│   │
│   ├── types/                        # TypeScript interfaces
│   │   ├── api.ts                    # Response types
│   │   ├── domain.ts                 # Entity models
│   │   ├── forms.ts                  # Form data types
│   │   └── enums.ts                  # Enums
│   │
│   ├── utils/                        # Utility functions
│   │   ├── formatting.ts             # Currency, date formatting
│   │   ├── validation.ts             # Form validation rules
│   │   ├── calculation.ts            # Accounting calculations
│   │   ├── errorHandler.ts           # Centralized error handling
│   │   └── constants.ts              # App-wide constants
│   │
│   ├── styles/                       # Global & theme styles
│   │   ├── theme.ts                  # MUI theme configuration
│   │   ├── globals.css
│   │   └── animations.css
│   │
│   ├── middleware/
│   │   ├── authMiddleware.tsx        # Protected route wrapper
│   │   └── entityMiddleware.tsx      # Entity context provider
│   │
│   ├── App.tsx
│   ├── main.tsx                      # Vite entry point
│   └── vite-env.d.ts
│
├── public/
│   ├── favicon.ico
│   └── assets/
│       ├── logos/
│       └── images/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
├── .env.example
├── .env.local
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
└── package.json
```

### Key Component Examples

**Layout Structure (Layout.tsx)**
```
<AppLayout>
  <Header>
    <Logo />
    <EntitySwitcher />
    <UserMenu />
  </Header>
  <Layout>
    <Sidebar>
      <Nav items={navItems} />
    </Sidebar>
    <MainContent>
      {children}
    </MainContent>
  </Layout>
  <Footer />
</AppLayout>
```

**DataTable Component Pattern**
- Server-side pagination
- Column sorting
- Filtering with debounce
- Row selection
- Bulk actions
- Export to CSV/Excel

---

## Implementation Phases

### Phase 1: Foundation (Weeks 1-2) - 60 hours

**Objectives**: Setup project structure, authentication, multi-tenancy framework

**Deliverables**:
1. Full-stack project setup (Vite, Node/Express, SQLite)
2. Database schema creation & migrations
3. Authentication system (JWT, login/register)
4. Multi-tenancy middleware & context
5. Error handling & validation framework
6. Basic app shell (layout, navigation, routing)

**Backend Tasks** (35 hours):
- [ ] Initialize Node.js project with TypeScript
- [ ] Setup Express server with middleware pipeline
- [ ] Configure SQLite with query builder (Knex.js)
- [ ] Implement authentication service (bcrypt, JWT)
- [ ] Create database migrations
- [ ] Build user & entity repository classes
- [ ] Setup global error handler & logging
- [ ] Create API request validation middleware

**Frontend Tasks** (25 hours):
- [ ] Initialize React/Vite project with TypeScript
- [ ] Configure build tools (Vite, ESLint, Prettier)
- [ ] Setup Redux Toolkit with slices
- [ ] Build Axios client with interceptors
- [ ] Create authentication pages (Login, Register)
- [ ] Build basic app layout & navigation
- [ ] Setup routing & protected routes
- [ ] Configure MUI theme

**Testing**: Unit tests for auth service, API client

---

### Phase 2: Core Domain (Weeks 3-4) - 70 hours

**Objectives**: Chart of Accounts, Journal Entry creation, GL posting

**Deliverables**:
1. Full CRUD for Chart of Accounts
2. Journal Entry creation with validation
3. GL auto-posting mechanism
4. Account hierarchy & drill-down
5. Transaction search & filtering

**Backend Tasks** (40 hours):
- [ ] COA service (create, update, delete, hierarchy)
- [ ] Account repository with relationship loading
- [ ] Journal Entry service & validation
- [ ] GL posting engine (double-entry logic)
- [ ] Transaction search/filter API endpoints
- [ ] Bulk import COA from Beancount
- [ ] Implement audit logging for all changes
- [ ] Setup database indexes for performance

**Frontend Tasks** (30 hours):
- [ ] Chart of Accounts listing & hierarchy view
- [ ] Account creation/edit modal & form
- [ ] Journal Entry form with dynamic line items
- [ ] Entry validation UI (balance warnings)
- [ ] GL search & filter UI
- [ ] Account detail page with drill-down
- [ ] Bulk import UI modal
- [ ] Real-time balance calculation display

**Testing**: Integration tests for GL posting, COA validation

**Beancount Import**: Parse Beancount file, map to DB schema

---

### Phase 3: Reporting & Dashboard (Weeks 5-6) - 60 hours

**Objectives**: Financial statements, KPI dashboard, data export

**Deliverables**:
1. P&L statement generation
2. Balance Sheet assembly
3. Trial Balance report
4. Dashboard with key metrics
5. Export to CSV/PDF/Excel
6. Account-level detail reports

**Backend Tasks** (35 hours):
- [ ] P&L report generation service
- [ ] Balance Sheet calculation engine
- [ ] Trial Balance verification
- [ ] Cash position calculation
- [ ] A/R & A/P aging reports
- [ ] Report query optimization
- [ ] Export service (CSV, PDF, Excel)
- [ ] Endpoint for all report types

**Frontend Tasks** (25 hours):
- [ ] Dashboard layout with KPI cards
- [ ] P&L page with filters (date range, accounts)
- [ ] Balance Sheet presentation
- [ ] Trial Balance table view
- [ ] Cash flow chart & widget
- [ ] A/R & A/P summary widgets
- [ ] Export modal (format selection)
- [ ] Report customization/drill-down
- [ ] Date range & comparison selectors

**Testing**: Report accuracy validation, data consistency checks

---

### Phase 4: Reconciliation & Advanced Features (Weeks 7-8) - 60 hours

**Objectives**: Account reconciliation, multi-user workflow, polish

**Deliverables**:
1. Reconciliation workflow (start, match, complete)
2. Variance analysis & reporting
3. Approval workflow for journal entries
4. Multi-user role-based features
5. Advanced filtering & search
6. UI/UX polish

**Backend Tasks** (35 hours):
- [ ] Reconciliation service & matching engine
- [ ] Variance calculation & analysis
- [ ] Journal Entry approval workflow
- [ ] Role-based permission checking
- [ ] Advanced search (fulltext, date ranges)
- [ ] Batch operations (post multiple entries)
- [ ] User audit trail filtering
- [ ] Performance optimization

**Frontend Tasks** (25 hours):
- [ ] Reconciliation page layout
- [ ] GL matching interface (drag-drop or checkboxes)
- [ ] Variance report display
- [ ] Approval workflow UI
- [ ] Role-based feature toggling
- [ ] Advanced search component
- [ ] Batch action UI
- [ ] Responsive mobile layout
- [ ] Accessibility improvements (a11y)

**Testing**: E2E reconciliation flow, multi-user scenarios, permissions

---

### Phase 5: Deployment & Documentation (Weeks 9-10) - 30 hours

**Objectives**: Production readiness, deployment, documentation

**Deliverables**:
1. Dockerization (optional)
2. Environment configuration
3. Database migration scripts
4. Security hardening
5. API documentation (OpenAPI/Swagger)
6. User & developer documentation
7. Performance optimization
8. Backup & recovery procedures

**Tasks** (30 hours):
- [ ] Docker setup (frontend, backend, db)
- [ ] Environment variables configuration
- [ ] Database backup & recovery scripts
- [ ] Security audit (OWASP Top 10)
- [ ] API documentation (Swagger/OpenAPI)
- [ ] User manual & FAQs
- [ ] Developer setup guide
- [ ] Performance profiling & optimization
- [ ] Load testing with Artillery
- [ ] Monitoring & logging setup
- [ ] CI/CD pipeline (GitHub Actions)

---

## Critical Path & Dependencies

### Dependency Graph

```
Phase 1: Foundation
├── Database setup ──→ Phase 2: Domain
│   ├── COA CRUD ──→ Phase 3: Reporting
│   │   ├── P&L generation
│   │   ├── Balance Sheet
│   │   └── Dashboard
│   │
│   └── Journal Entry ──→ GL Posting ──→ Phase 4: Reconciliation
│       └── Approval workflow

Phase 1: Auth ──→ All Phases
Phase 1: Layout ──→ All Frontend
```

### Must-Complete-First Items

1. **Database schema** (blocks all backend work)
2. **Auth service** (blocks all API calls)
3. **Multi-tenancy middleware** (needed for entity isolation)
4. **Journal Entry + GL posting** (foundation for reporting)
5. **P&L/Balance Sheet** (validation of GL posting correctness)

### Parallel Work Possible

- Frontend UI building (while backend implements data layer)
- Report queries (while reconciliation is being built)
- Tests & documentation (throughout all phases)

---

## File Structure & Naming Conventions

### Backend Code Organization

```
backend/
├── src/
│   ├── app.ts                           # Express app setup
│   ├── server.ts                        # Server entry point
│   ├── config/
│   │   ├── database.ts
│   │   ├── env.ts
│   │   ├── constants.ts
│   │   └── logger.ts
│   ├── middleware/
│   │   ├── auth.ts
│   │   ├── errorHandler.ts
│   │   ├── entityContext.ts
│   │   ├── validation.ts
│   │   └── audit.ts
│   ├── routes/
│   │   ├── index.ts
│   │   ├── auth.ts
│   │   ├── entities.ts
│   │   ├── chartOfAccounts.ts
│   │   ├── generalLedger.ts
│   │   ├── journalEntries.ts
│   │   ├── reports.ts
│   │   ├── reconciliations.ts
│   │   ├── users.ts
│   │   └── admin.ts
│   ├── controllers/
│   │   ├── authController.ts
│   │   ├── entityController.ts
│   │   ├── coaController.ts
│   │   ├── glController.ts
│   │   ├── journalController.ts
│   │   ├── reportController.ts
│   │   ├── reconciliationController.ts
│   │   └── userController.ts
│   ├── services/
│   │   ├── authService.ts
│   │   ├── entityService.ts
│   │   ├── coaService.ts
│   │   ├── glService.ts
│   │   ├── journalService.ts
│   │   ├── reportService.ts
│   │   ├── reconciliationService.ts
│   │   ├── auditService.ts
│   │   └── importService.ts
│   ├── repositories/
│   │   ├── baseRepository.ts
│   │   ├── userRepository.ts
│   │   ├── entityRepository.ts
│   │   ├── chartOfAccountsRepository.ts
│   │   ├── generalLedgerRepository.ts
│   │   ├── journalEntryRepository.ts
│   │   ├── reconciliationRepository.ts
│   │   └── auditLogRepository.ts
│   ├── models/
│   │   ├── User.ts
│   │   ├── Entity.ts
│   │   ├── ChartOfAccount.ts
│   │   ├── GeneralLedger.ts
│   │   ├── JournalEntry.ts
│   │   ├── Reconciliation.ts
│   │   └── AuditLog.ts
│   ├── validators/
│   │   ├── authValidator.ts
│   │   ├── coaValidator.ts
│   │   ├── journalValidator.ts
│   │   ├── entityValidator.ts
│   │   └── base.ts                      # Base validation rules
│   ├── utils/
│   │   ├── errorHandler.ts
│   │   ├── logger.ts
│   │   ├── accounting.ts                # GL posting, balance calc
│   │   ├── password.ts
│   │   ├── jwt.ts
│   │   ├── pagination.ts
│   │   └── constants.ts
│   ├── types/
│   │   ├── express.d.ts                 # Express type augmentation
│   │   ├── index.ts
│   │   ├── api.ts
│   │   ├── domain.ts
│   │   ├── errors.ts
│   │   └── enums.ts
│   ├── migrations/
│   │   ├── 001_initial_schema.sql
│   │   ├── 002_audit_tables.sql
│   │   ├── 003_indexes.sql
│   │   └── 004_seed_data.sql
│   └── scripts/
│       ├── seedDatabase.ts
│       ├── importBeancount.ts
│       └── backupDatabase.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── fixtures/
│   └── setup.ts
├── .env.example
├── .env.local
├── tsconfig.json
├── package.json
└── README.md
```

### Naming Conventions

**Files**:
- Controllers: `*Controller.ts` (e.g., `journalController.ts`)
- Services: `*Service.ts` (e.g., `reportService.ts`)
- Repositories: `*Repository.ts` (e.g., `glRepository.ts`)
- Validators: `*Validator.ts` (e.g., `coaValidator.ts`)
- Models: PascalCase (e.g., `ChartOfAccount.ts`)
- Migrations: `NNN_description.sql` (e.g., `001_initial_schema.sql`)
- Tests: `*.test.ts` or `*.spec.ts`

**Functions/Methods**:
- camelCase for all functions
- Service methods: `create`, `read`/`getById`, `update`, `delete`, `list`/`findAll`
- Validation: `validate*` prefix (e.g., `validateJournalEntry`)
- Query builders: `getBy*` prefix (e.g., `getByEntityId`)

**Constants**:
- UPPER_SNAKE_CASE
- Group in dedicated `constants.ts` file

**Types/Interfaces**:
- PascalCase
- Prefix with `I` for interfaces (optional but recommended)
- Response types: `*Response` suffix
- Request types: `*Request` suffix

---

## Key Architectural Decisions

### 1. Multi-Tenancy Strategy

**Decision**: Database-per-entity (logical isolation with entity_id FK)

**Rationale**:
- Simpler than true schema isolation
- Easier migrations and backups
- Better for small-medium scale
- Can evolve to schema-per-entity later

**Implementation**:
- All tables include `entity_id` foreign key
- Entity middleware injects entity context
- Queries always filtered by entity_id
- Row-level security enforced at service layer

### 2. Authentication & Authorization

**Decision**: JWT with refresh tokens + session store (Redis optional)

**Rationale**:
- Stateless JWT for API scalability
- Refresh tokens for security
- Role-Based Access Control (RBAC) at resource level
- MFA support via TOTP

**Flow**:
```
1. User login → validate credentials
2. Issue JWT + refresh_token
3. Client stores both (JWT in memory, refresh in httpOnly cookie)
4. All requests include JWT in Authorization header
5. Middleware validates & extracts user context
6. Service layer checks entity_id + role
```

### 3. General Ledger Design

**Decision**: Double-entry bookkeeping with GL transaction records

**Rationale**:
- Standard accounting practice
- Data integrity enforced at DB constraints
- Audit trail naturally emerges from GL
- Easy to reconcile and report from

**Posting Flow**:
```
1. User creates Journal Entry (DRAFT status)
2. Validate: debits = credits, accounts exist, permissions
3. On POST action:
   a. Create GL records for each journal line
   b. Update account balances
   c. Set journal status to POSTED
   d. Audit log all changes
```

### 4. Report Generation Strategy

**Decision**: Query-based (real-time) with optional caching layer

**Rationale**:
- Always current data (no stale snapshots)
- Flexible filtering & drill-down
- Simple to implement initially
- Can add Redis caching layer if needed

**Optimization**:
- Indexed queries on (entity_id, account_id, date)
- Materialized views for heavy reports (later phase)
- Pre-calculated daily balances (denormalization)

### 5. Error Handling

**Decision**: Centralized error class hierarchy + middleware catch-all

**Strategy**:
```typescript
class AppError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
    public details?: any
  ) { super(message); }
}

// Specific errors
class ValidationError extends AppError { }
class NotFoundError extends AppError { }
class AuthenticationError extends AppError { }
class AuthorizationError extends AppError { }

// Global middleware catches & formats
app.use((err, req, res, next) => {
  const response = {
    success: false,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    }
  };
  res.status(err.statusCode || 500).json(response);
});
```

### 6. Validation Strategy

**Decision**: Schema validation (Zod) + custom business logic validators

**Implementation**:
```typescript
// Request validation (Zod)
const createJournalSchema = z.object({
  entryDate: z.date(),
  description: z.string().min(1).max(500),
  lines: z.array(journalLineSchema).min(2)
});

// Business logic validation
const validateJournalBalance = (journal: Journal) => {
  const totalDebit = journal.lines.reduce((sum, line) => sum + line.debit, 0);
  const totalCredit = journal.lines.reduce((sum, line) => sum + line.credit, 0);
  if (totalDebit !== totalCredit) {
    throw new ValidationError('UNBALANCED', 400, 'Journal must balance');
  }
};
```

### 7. Audit Trail

**Decision**: Dedicated audit_logs table + middleware capture

**What to audit**:
- Create, Update, Delete operations
- All GL & Journal posting
- All reconciliation changes
- User access (logins, role changes)

**Capture format**:
```json
{
  "user_id": "uuid",
  "action": "POSTED",
  "resource_type": "JOURNAL_ENTRY",
  "resource_id": "uuid",
  "old_values": { "status": "DRAFT" },
  "new_values": { "status": "POSTED" },
  "timestamp": "2026-06-16T12:00:00Z"
}
```

### 8. Database Migration Strategy

**Decision**: SQL migration files + Knex.js schema builder (hybrid)

**Why hybrid**:
- SQL for complex operations (performance)
- Knex for portability (SQLite → Postgres)
- Version control for all migrations
- Rollback capability

**File naming**: `YYYYMMDD_HHmmss_description.sql`

### 9. Frontend State Management

**Decision**: Redux Toolkit (with RTK Query for data fetching)

**Store structure**:
```
auth/          # User login, token
entities/      # Current entity context
ui/            # Modal state, loading flags
settings/      # User preferences
```

**Entities** (RTK Query):
- Lazy-loaded from API
- Built-in caching
- Automatic refetch on updates

### 10. Beancount Import Strategy

**Decision**: Server-side parser + validation + bulk insert

**Flow**:
```
1. User uploads .beancount file
2. Server parses file (commodity, accounts, open/close directives)
3. Validate:
   - Account numbers unique per entity
   - Account types map to system types
   - Opening balances make sense
4. Bulk insert into COA + optional initial GL entries
5. Return import report (success count, validation errors)
```

---

## Deployment Strategy

### Local Development Setup

**Prerequisites**:
- Node.js 18+
- npm or yarn
- SQLite3 CLI (or use Node driver)

**Setup steps**:
```bash
# Backend
cd backend
npm install
cp .env.example .env.local
npm run db:migrate
npm run db:seed
npm run dev

# Frontend (new terminal)
cd frontend
npm install
npm run dev
```

### Production Deployment Options

#### Option A: Docker Compose (Recommended for Small Teams)

```dockerfile
# Dockerfile.backend
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 5000
CMD ["npm", "start"]

# Dockerfile.frontend
FROM node:18-alpine as builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
```

```yaml
# docker-compose.yml
version: '3.9'
services:
  backend:
    build: ./backend
    ports:
      - "5000:5000"
    environment:
      - DATABASE_URL=sqlite:./data/app.db
      - JWT_SECRET=${JWT_SECRET}
      - NODE_ENV=production
    volumes:
      - ./data:/app/data
  
  frontend:
    build: ./frontend
    ports:
      - "80:80"
    depends_on:
      - backend
```

#### Option B: Direct Installation

**Linux/Mac**:
```bash
# Clone & setup
git clone <repo>
cd accounting-app

# Backend
cd backend && npm install && npm run build
nohup npm start > backend.log 2>&1 &

# Frontend (build + serve)
cd ../frontend && npm install && npm run build
npx serve -s dist -l 3000 &
```

**Windows PowerShell**:
```powershell
# Similar to above, use `Start-Process` for background jobs
```

### Database Migration to Postgres (Future)

**Steps**:
1. Keep SQLite for dev, use Postgres in prod
2. All migration files work with both (via Knex abstraction)
3. Update `DATABASE_URL` env variable
4. No code changes needed (Knex handles it)

```javascript
// knexfile.js - environment-based
module.exports = {
  development: {
    client: 'sqlite3',
    connection: ':memory:',
    useNullAsDefault: true
  },
  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL,
    migrations: { extension: 'sql' }
  }
};
```

---

## Development Workflow & Best Practices

### Git Workflow

```
main (production-ready)
├── develop (integration branch)
│   ├── feature/chart-of-accounts
│   ├── feature/journal-entries
│   ├── feature/reporting
│   └── feature/reconciliation
└── hotfix/...
```

**Branch naming**: `{type}/{description}`
- `feature/` - New features
- `bugfix/` - Bug fixes
- `refactor/` - Code improvements
- `test/` - Test additions

### Code Quality Standards

**TypeScript**:
- Strict mode enabled
- No `any` types (use `unknown` if necessary)
- All functions have return types
- Full test coverage for services

**Linting**:
- ESLint + Prettier
- Format on save
- Automatic CI validation

**Testing Requirements**:
- Unit tests: Services, validators, utilities (>80% coverage)
- Integration tests: API endpoints, DB operations
- E2E tests: Critical user flows (login, journal entry, report)

**Code Review Checklist**:
- [ ] Code follows naming conventions
- [ ] Tests included
- [ ] Database migrations provided (if schema change)
- [ ] Documentation updated
- [ ] No console.logs left in production code
- [ ] Error handling included
- [ ] Audit logging added (if needed)

---

## Estimated Time Summary

| Phase | Duration | Hours | Focus |
|-------|----------|-------|-------|
| 1. Foundation | 2 weeks | 60 | Setup, auth, DB |
| 2. Core Domain | 2 weeks | 70 | COA, Journal, GL |
| 3. Reporting | 2 weeks | 60 | Reports, Dashboard |
| 4. Reconciliation | 2 weeks | 60 | Recon, Workflow, Polish |
| 5. Deployment | 1-2 weeks | 30 | Testing, Deploy, Docs |
| **Total** | **9-10 weeks** | **280 hours** | **MVP Complete** |

---

## Success Criteria (Acceptance Tests)

- [ ] All major entities can be created, read, updated
- [ ] Journal entries post to GL without errors
- [ ] P&L + Balance Sheet reconcile with GL
- [ ] Multi-user can work simultaneously without conflicts
- [ ] Beancount import succeeds with validation
- [ ] Reconciliation reduces variance to zero
- [ ] Audit trail captures all changes
- [ ] Auth prevents unauthorized access
- [ ] API responses follow documented format
- [ ] Frontend is responsive (mobile + desktop)
- [ ] Error messages are helpful & consistent
- [ ] Application loads in <3 seconds
- [ ] No unhandled promise rejections
- [ ] Deployment runs without manual steps

---

## Future Enhancements (Post-MVP)

1. **Multi-Currency Support**: Handle FX conversions, gain/loss
2. **Bank Integration**: Auto-import bank transactions
3. **Tax Module**: Calculate quarterly/annual tax liabilities
4. **Budgeting**: Create & track budgets vs. actual
5. **Workflow Approval**: Multi-level approval chains
6. **Mobile App**: React Native or PWA
7. **Webhooks**: Push events to external systems
8. **API Rate Limiting**: Throttle per-user/entity
9. **Data Visualization**: Advanced dashboards, predictive analytics
10. **Compliance**: SOX, GDPR, HIPAA audit readiness

---

## Appendix: Quick Reference

### Database Connection String Examples

**SQLite**: `sqlite:./data/app.db`  
**Postgres**: `postgresql://user:pass@localhost:5432/accounting`  
**MySQL**: `mysql://user:pass@localhost:3306/accounting`

### Key Environment Variables

```env
# Backend
NODE_ENV=development|production
DATABASE_URL=sqlite:./data/app.db
JWT_SECRET=your-secret-key-min-32-chars
JWT_EXPIRY=3600  # seconds
REFRESH_TOKEN_EXPIRY=604800  # 7 days
LOG_LEVEL=debug|info|warn|error
CORS_ORIGIN=http://localhost:3000

# Frontend
VITE_API_URL=http://localhost:5000
VITE_APP_NAME=Accounting Pro
VITE_ENVIRONMENT=development
```

### Useful npm Scripts

**Backend**:
```json
{
  "dev": "ts-node-dev --respawn src/server.ts",
  "build": "tsc",
  "start": "node dist/server.js",
  "test": "vitest",
  "test:coverage": "vitest --coverage",
  "db:migrate": "knex migrate:latest",
  "db:rollback": "knex migrate:rollback",
  "db:seed": "ts-node src/scripts/seedDatabase.ts",
  "lint": "eslint src/**/*.ts",
  "format": "prettier --write src/**/*.ts"
}
```

**Frontend**:
```json
{
  "dev": "vite",
  "build": "tsc && vite build",
  "preview": "vite preview",
  "test": "vitest",
  "test:ui": "vitest --ui",
  "lint": "eslint src/**/*.{ts,tsx}",
  "format": "prettier --write src/**/*.{ts,tsx}",
  "type-check": "tsc --noEmit"
}
```

---

## Document Control

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-06-16 | System | Initial implementation plan |

