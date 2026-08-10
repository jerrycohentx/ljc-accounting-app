# CTO Handoff

This file is the shared coordination channel for Codex, Cursor, and any other
engineering agent working on LJC Accounting. Jerry is the product owner, not
the message bus. Agents must read this file before starting work and update it
before stopping or handing work to another agent.

## Active handoff

- **Owner:** Codex
- **Status:** READY FOR CURSOR REVIEW / MERGE
- **Branch:** `fix/semantic-categorization-guardrails`
- **Commit:** `1a9184fd`
- **Objective:** Prevent economically nonsensical automatic categorizations and
  make explicit vendor rules safe to learn.
- **Reported example:** Simmons 2026-01-23, `$725.87`, `C.D. INTEREST ACCOUNT
  NUMBER 112946` was incorrectly categorized to `Lending Income:Portfolio
  loans:NSF payments:Bank NSF fees charged`.
- **Expected accounting:** Bank/CD interest income (`4000`, Interest Income -
  Banks), not NSF income.
- **Implemented:**
  - semantic intent inference for CD/bank interest, NSF items, and bank fees;
  - contradictory learned rules are skipped instead of winning by priority;
  - contradictory new vendor rules are rejected;
  - stale `C.D. INTEREST` and `INTEREST PAID` defaults self-heal to `4000`;
  - focused regression tests for the exact CD-interest/NSF failure.
- **Verification:** `node --test lib/categorization-logic.test.js` — 4 passed.
- **Not yet done:** Merge/deploy to staging; reclassify the historical January
  entry through the audited correction workflow; finish the reconciliation UI
  improvements requested below.

## Reconciliation UI requirements

1. Hide/collapse the global navigation sidebar automatically while a
   reconciliation statement is open; provide a clear `Exit reconciliation`
   control to restore it.
2. Give the statement materially more space: user-resizable split, one-click
   statement focus/full-width mode, and readable default PDF zoom.
3. Fix every row's `View` action. It must open journal debits/credits, current
   offset account, business event, and supporting evidence.
4. From `View`, allow an inaccurate cleared entry to be corrected through an
   audited reclassification. Clearing status must remain intact unless the
   accounting correction changes the bank-side amount/date.
5. After a correction, explicitly offer `Always use this category` with an
   editable vendor/memo pattern. Never silently learn from a one-off choice.
6. Before saving or applying a rule, run semantic accounting guardrails. A
   vendor rule cannot override obvious transaction meaning or debit/credit
   direction.

## Mandatory agent protocol

1. Read `AGENTS.md` and this file before changing code.
2. Work on a named branch; never leave the only copy of work in an agent's
   private workspace.
3. Record branch, commit, tests, live deployment/build, and remaining work here.
4. Push the branch before handoff. The receiving agent fetches it directly.
5. Do not ask Jerry to copy technical status, patches, prompts, or error logs
   between agents. If a handoff cannot be completed, state the exact repository
   or access blocker in this file.
6. Never mark work live or complete without verifying the actual staging build.

