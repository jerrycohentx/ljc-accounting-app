# Lone Star January 2026 — classification exceptions (read-only)

Cash recon is **not** in question and is **not** reopened:

| | Amount |
|---|---:|
| Statement ending | $726.07 |
| Book ending | $726.07 |
| Difference | $0.00 |

Live proof (2026-08-12T20:25:46Z and re-checked with `--capture-ljcos`): 1001 `ok: true`, session `CLOSED`, `liveTotals.difference === 0`, January `isClosed: true`. No journals posted or reversed in this work.

Claude conclusions remain **UNVERIFIED** (package hashes never arrived). These three items were already `NEEDS REVIEW` on the live register.

No categorization rules created. No corrections posted. Chairman approval required before any mutation.

---

## 1. January 15 — $2,019.74 loan payment (principal / interest / fee)

### Cash (authoritative for 1001)

- Statement: `LOAN PAYMENT` 2026-01-15 −$2,019.74 FITID `pdf-8df317a6c24fd902934e994f`
- Live journal: `IMP-1784868436888-f53d43b4` (`je-8179d102-97c6-4521-8f22-86b8a495ee24`)
- Books: **CR 1001 $2,019.74 / DR 2130 WLOC - Lone Star Bank $2,019.74**
- Not reversed. Matches the checking statement once.

### Servicing evidence searched

| Source | Result |
|---|---|
| Lone Star WLOC loan statement / coupon in repo or inbox | **Not present** |
| `loan_tracker_events` for 2026-01-15 amount 201974 cents | **No match** (tracker events are LJC’s *lending* book; this cash is LJC *paying* Lone Star) |
| Simmons OFX / Simmons statement JSON | **No** $2,019.74 |
| QBO Jan 2026 P&L “Interest expense-Banks: Lone Star Bank” | **$8,437.74** — different number; **not** a split of $2,019.74 |

### Do not confuse with Chapman JE-10

`JE-1783810950865` (memo `Feb-close plan JE-10`, created 2026-07-11, **no source document**):

| Account | Debit | Credit |
|---|---:|---:|
| 2140 Notes Payable - 1721 Chapman (Lone Star) | 195.30 | |
| 5000 Interest Expense | 1,157.10 | |
| 1410 Mortgage / Servicing Escrow | 667.34 | |
| 1300 Notes Receivable | | 2,019.74 |

$195.30 + $1,157.10 + $667.34 = $2,019.74, but this JE **does not touch 1001**. It reclasses Notes Receivable. It is not a WLOC coupon and is not attached servicing evidence. Same date/amount is **not** proof it is the checking-account WLOC payment.

### Proposed treatment (do not post)

- **Leave 1001 cash as booked** (DR 2130 / CR 1001).
- **Do not allocate** principal/interest/fee until a Lone Star **WLOC statement or coupon** for this payment is deposited in `claude/` and checksum-verified.
- Do not apply Chapman JE-10 numbers to the WLOC cash line.

**Status:** UNRESOLVED — no authoritative servicing split.

---

## 2. January 16 — $3,209 DDA debit memo

### Cash (authoritative for 1001)

- Statement: `DDA DEBIT MEMO` 2026-01-16 −$3,209.00 FITID `pdf-2dbbdc208ba65492ad1edbbc`
- Live journal: `IMP-1784868437189-2cb3a760` (`je-67a73773-1b58-4b6c-8c44-ca9f2daa5e12`)
- Books: **CR 1001 $3,209.00 / DR 2120 LOC - Lone Star Bank $3,209.00**
- Not reversed. Matches the checking statement once.

### Servicing / bank evidence searched

| Source | Result |
|---|---|
| Debit-memo advice / LOC note in repo or inbox | **Not present** |
| Simmons OFX / statement JSON | **No** $3,209 |
| `loan_tracker_events` | **No** 320900 cents on 2026-01-16 |

### Conflicting close-plan JE (not source)

`JE-1783810950398` (memo `Feb-close plan JE-9`): DR **2130** $32,784.00 / CR 1300 $32,784.00, description “1/13 29575 + 1/16 3209”. No source document. The live IMP remains on **2120**. Adopting JE-9 without reversing or reclassing the IMP would **double-count** the $3,209 liability reduction. Not used as evidence.

### Proposed treatment (do not post)

- **Leave 1001 cash as booked.**
- Classification 2120 vs 2130 vs something else: **UNRESOLVED** until Lone Star debit-memo advice or LOC/WLOC statement is in `claude/`.

**Status:** UNRESOLVED — business purpose not established from source documents.

---

## 3. January 13 — $29,575 credit and $29,575 debit

### Cash (authoritative for 1001)

| Side | Statement | Live journal | 1001 | Offset |
|---|---|---|---:|---|
| Credit | DDA Credit Memo +$29,575 FITID `pdf-88497870f0a5f28a8f91b599` | `IMP-1784868433796-38b01618` | DR 29,575.00 | CR 2120 |
| Debit | DDA DEBIT MEMO −$29,575 FITID `pdf-5452b17568954abc4523c4c3` | `IMP-1784868435888-b4354af2` | CR 29,575.00 | DR 2120 |

Net 1001 cash **$0.00**. Both lines are on the statement once. Neither live IMP is reversed.

### Servicing / bank evidence searched

| Source | Result |
|---|---|
| Memo advice / wire detail in repo or inbox | **Not present** |
| Simmons OFX / statement JSON | **No** $29,575 |
| `loan_tracker_events` | **No** 2957500 cents on 2026-01-13 |

Same-day equal in/out is consistent with an advance and same-day paydown **or** a book-transfer through checking. That is **not** established. Not inferred.

JE-9 (above) folds $29,575 into a $32,784 2130/1300 reclass without a source PDF. Not used.

### Proposed treatment (do not post)

- **Leave 1001 cash as booked** (pair nets $0.00; recon stays $0.00).
- Balance-sheet offset (2120 vs 2130 vs 1300 vs other): **UNRESOLVED** until Lone Star memo advice is checksum-deposited.

**Status:** UNRESOLVED — underlying transaction not established from source documents.

---

## Chairman

No accounting mutation is requested. Needed before any reclass: hashed Lone Star WLOC/LOC statements or debit/credit memo advices in `claude/`, then a new Cursor verification. Cash recon stays $726.07 / $0.00.
