# AGENTS.md — LJC Accounting (Cohen Entities)

This file is the standing brief for any Cursor agent working in this repo.

## Who you are working for

Jerry Cohen — owner of LJC Financial LLC. Not a developer. Never hand him technical homework. Execute end-to-end; report outcomes in plain English.

**Truth over comfort.** Never claim a month is closed or a bank/card is reconciled unless live integrity says so with zero blockers. Soft language and partial checks that overclaim are a firing offense (see `.cursor/rules/truth-hard-bar.mdc`).

**No circumvention.** Do not weaken gates, redefine “done,” or talk around Jerry’s instructions to get a green status. Fix the books. If you find a loophole, close it in code/rules in the same turn (see `.cursor/rules/no-circumvention.mdc`).

**Proof required.** Never tell Jerry a month is closed, a recon is done, or books are clean unless that **same message** pastes live integrity / `verify-books-clean` proof (`isClosed`, blockers, per-account ok). No proof → no claim. See `.cursor/rules/proof-required.mdc`.

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
4. Before claiming a month is closed: call the integrity endpoint; only `isClosed: true` counts. **No exceptions** — BOOK_NE_STATEMENT, non-zero 3900/plugs, or any blocker means **not closed** (never “closed with caveats”).
5. Before claiming a bank/card recon is done: Cleared = statement **and** books as of statement date = statement ending (`liveTotals.difference === 0`); never trust a CLOSED banner alone
6. Never create plug / reconcile-adjustment / force-balance journal entries
7. Before claiming books are clean or openings rebuilt: run `node scripts/verify-books-clean.mjs --entity ent-ljc --asOf YYYY-MM-DD` — **BS Net Income must equal calendar YTD P&L**, prior-year P&L closed (`netIncomeTieoutOk`), TB/BS balanced, plugs $0. See `.cursor/rules/books-clean-definition-of-done.mdc`.
8. **Anticipate Jerry’s next click.** If he is in Review & Approve on a closed month, make posting work *before* he hits the error — do not wait for a screenshot (see `.cursor/rules/anticipate-workflow-blockers.mdc`)

## Learning loop (product direction)

- Confirmed categorizations → durable rows in `bank_categorization_rules` (and related)
- Low-confidence AI suggestions → review queue, never silent post below confidence threshold
- Background jobs (Plaid sync, statement ingest, ACH JE scan) — not chat sessions — own the schedule

## Entities in scope

LJC, Justin Financial, OMC Housing, Graceful Meadows, 4J&L, QOF — multi-entity, tenant-scoped queries always.
