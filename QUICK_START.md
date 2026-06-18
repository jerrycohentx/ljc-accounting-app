# LJC Accounting App - Quick Start (5 Minutes)

## One-Time Setup

### 1. Install & Initialize Database

```bash
cd ljc-accounting-app
npm install
python3 scripts/setup-production.py
```

Done! Your database is ready at `./db/accounting.db`

**Credentials created:**
- Email: `jerry@ljcfinancial.com`
- Password: `LJCAccounting2026!` (change on first login)

## Every Time You Use the App

### 2. Start Backend (Terminal 1)

```bash
npm run dev
```

Wait for: `✓ Server running on http://localhost:3000`

### 3. Start Frontend (Terminal 2)

```bash
cd frontend
npm run dev
```

Wait for: `➜ Local: http://localhost:5173/`

### 4. Open in Browser

Go to: **http://localhost:5173/**

Login with credentials from step 1.

## Using Bank Import

1. Click **Bank Import**
2. Select entity (LJC Financial)
3. Upload your OFX file from bank
4. Review preview
5. Click **Confirm Import**
6. Go to **Journals** to review
7. Post to ledger when ready

## Using Bank Reconciliation

1. Click **Bank Reconciliation**
2. Select entity and account
3. Click **Auto-Match All**
4. Click **Clear** when done
5. Verify variance = $0.00

Done!

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Can't parse OFX | Check file is .ofx (Web Connect format) from bank |
| Server won't start | Check port 3000 is free: `lsof -i :3000` then kill process |
| "Database locked" | Restart backend (Ctrl+C then `npm run dev`) |
| Forgot password | Run `python3 scripts/setup-production.py` to reset |

---

## Important Files

- Database: `./db/accounting.db`
- Documentation: `STARTUP.md` (comprehensive guide)
- Implementation: `PHASE_5A_IMPLEMENTATION.md` (technical details)
- OFX Parser: `lib/OFX_PARSER_README.md` (how it works)

---

**Questions?** See `STARTUP.md` for detailed instructions.
