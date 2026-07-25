# AGENTS.md — LJC Accounting (Cohen Entities)

This file is the standing brief for any Cursor agent working in this repo.

## Who you are working for

Jerry Cohen — owner of LJC Financial LLC. Not a developer. Never hand him technical homework. Execute end-to-end; report outcomes in plain English.

## North-star goal

Build an **agentic, autonomous accounting system** that:

1. Ingests bank/card activity (Plaid, OFX, statement email/PDF) with **idempotent** imports
2. Categorizes transactions automatically and **learns** durable rules from every confirmed categorization
3. Posts only **balanced** double-entry journals (integer cents / Decimal — never float money math)
4. Reconciles every monitored bank/card account to statement **$0.00** difference
5. **Hard-blocks** period close, plugs, and fake “closed” claims (see period integrity API)
6. Needs **minimal daily clicks** from Jerry — workers and queues do the routine work

Claude Cowork / chat agents are **helpers for building and investigating**, not the ledger runtime. **This app** is the system of record.

## Canonical paths

| What | Where |
|------|--------|
| This app (open this in Cursor) | `C:\Users\jerry\Claude\Projects\AI accounting\ljc-accounting-app` |
| Production | https://ljc-accounting-app.onrender.com (branch `master`) |
| Hard close / status truth | `GET /api/entities/:entityId/accounting/periods/integrity` |
| Standing rules | `TEN_COMMANDMENTS.md`, `.cursor/rules/*.mdc` |

Do **not** treat the OneDrive “Cohen Entities Accounting” shortcut folder as the codebase — it is only a link.

## How to work in this repo

1. Prefer smallest correct diffs; match existing Express / `lib/` / `routes/` patterns
2. After meaningful changes: verify locally or on Render; deploy when production must reflect the fix
3. Commit/push when shipping is part of finishing (production on `master`)
4. Before claiming a month is closed: call the integrity endpoint; only `isClosed: true` counts
5. Before claiming a bank/card recon is done: worksheet must show `periodSession.balanced === true` and `liveTotals.difference === 0` (never trust a CLOSED banner alone)
6. Never create plug / reconcile-adjustment / force-balance journal entries

## Learning loop (product direction)

- Confirmed categorizations → durable rows in `bank_categorization_rules` (and related)
- Low-confidence AI suggestions → review queue, never silent post below confidence threshold
- Background jobs (Plaid sync, statement ingest, ACH JE scan) — not chat sessions — own the schedule

## Entities in scope

LJC, Justin Financial, OMC Housing, Graceful Meadows, 4J&L, QOF — multi-entity, tenant-scoped queries always.
