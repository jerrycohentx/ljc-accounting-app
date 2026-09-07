# January 2026 chargeback lineage (read-only)

**Chairman decision honored:** A3 not authorized. 4010 rejected. 5801 not approved. $35 overdraft fees left in 5200. Unexplained $1,000 and $532.42 remain unresolved with **no journal**. Full restorable database snapshot is a **hard gate before A3**.

Generated from live production (`gitSha` at run time) plus Simmons 0260 OFX / bundled January statement JSON. No accounting mutations.

---

## A0 gate — full restorable snapshot

| Item | Status |
|---|---|
| `checkpoint-v1` metadata (`bak-20260812-200229` and priors) | Downloadable — **not** a ledger restore |
| `BACKUP_FULL_LEDGER=1` ledger-json / pg_dump | **Not enabled** on production |
| Full restorable database snapshot | **FAIL — A3 remains blocked** |

Live books remain in Render PostgreSQL. That is durable, but it is not an offline restorable snapshot.

---

## Current books (already moved off 4010)

Each January chargeback IMP originally posted `DR 4010 / CR 1000` via rule `Learned: CHARGEBACK`. A later **non-cash reclass** already moved the offset to 5801:

| Chargeback IMP | Reclass | Net offset today |
|---|---|---|
| IMP-1783739660882-99c3234d | RCLS-1785167914703-6a8bbe | 5801 |
| IMP-1783739660560-9d4a26fb | RCLS-1785167912807-e8388b | 5801 |
| IMP-1783739660391-acbc8332 | RCLS-1785167910504-2d1607 | 5801 |
| IMP-1783739660051-bc88e4b7 | RCLS-1785167908206-62d57f | 5801 |
| IMP-1783739659804-40487289 | RCLS-1785167906604-ac48d8 | 5801 |

Chairman has **not** approved 5801. These RCLS rows are existing history, not new A3 posts. No further entry is proposed.

---

## Lineage results (five items)

### CB-1 — $2,787.50 CHARGEBACK (2026-01-06)

| Field | Finding |
|---|---|
| Bank | LJC Simmons 0260 (1000) |
| Chargeback JE | `IMP-1783739660882-99c3234d` (`je-c4f54ab1-c63e-4cda-be95-fdc98ea5ff7e`) |
| Chargeback FITID | `20260106--2787-600-118-135` |
| Chargeback lines (IMP) | DR 4010 $2,787.50 / CR 1000 $2,787.50 |
| After RCLS | DR 5801 $2,787.50 / CR 4010 $2,787.50 (net: DR 5801 / CR 1000) |
| Borrower / loan | **Not identified** |
| Original payment date / amount | **Not found** in 2026 Simmons OFX or Oct 2025–Feb 2026 journals as a prior cash receipt of $2,787.50 |
| Original journal ID | **None** |
| Original DR/CR | **Unknown** |
| Servicing allocation (P/I/fees) | **None** — loan-tracker events have no matching amount; `payment_returns.loan_id` is null |
| Same-amount later cash | 2026-01-09 ACH BATCH `IMP-1783739661881-637e908b` DR 1000 / CR 4010 $2,787.50, then RCLS to 1220. This is **after** the chargeback (possible retry), not the original cleared payment |
| Exact undo if payment never cleared | **Cannot be written.** Requires the original receipt’s accounts. If original was DR 1000 / CR 4010, undo is DR 4010 / CR 1000 (the IMP). That is **not proven**. 5801 is not approved. |
| Evidence-match | **INCOMPLETE** |
| Confidence | **none** for borrower/loan; **high** that bank cash left on 1/6 |

### CB-2 — $8,834.17 CHARGEBACK (2026-01-05)

| Field | Finding |
|---|---|
| Bank | LJC Simmons 0260 (1000) |
| Chargeback JE | `IMP-1783739660560-9d4a26fb` (`je-f477785a-d0af-41e3-839f-fd07430540f6`) |
| Chargeback FITID | `20260105--8834-600-108-135` |
| Chargeback lines (IMP) | DR 4010 $8,834.17 / CR 1000 $8,834.17 |
| After RCLS | net DR 5801 / CR 1000 |
| Borrower / loan | **Not identified** |
| Original payment | **No** 2026 OFX credit of $8,834.17. **No** journal receipt of $8,834.17 in Oct 2025–Feb 2026 |
| Original journal / split | **Unknown** |
| Recurring bank NSF | Same amount appears as unmatched `payment_returns` ach_nsf on 2026-02-03, 2026-05-04, 2026-06-02 — still **no loan_id** |
| Exact undo | **Cannot be written** without original receipt |
| Evidence-match | **INCOMPLETE** |
| Note (out of January A3 scope) | Feb 3 `JE-1783871558211` posts another DR 5801 / CR 1000 $8,834.17. That is a later-month cash event, not January lineage. |

### CB-3 — $7,241.67 CHARGEBACK (2026-01-05)

Same pattern as CB-2.

| Field | Finding |
|---|---|
| Chargeback JE | `IMP-1783739660391-acbc8332` (`je-a23c2da1-ad3e-49e7-90cc-f44099408e42`) |
| FITID | `20260105--7241-600-109-135` |
| IMP lines | DR 4010 $7,241.67 / CR 1000 $7,241.67 |
| After RCLS | net DR 5801 / CR 1000 |
| Original payment / borrower / split | **Not found** |
| Recurring NSF | 2026-02-03, 2026-05-04, 2026-06-02 `payment_returns` — no loan_id |
| Exact undo | **Cannot be written** |
| Evidence-match | **INCOMPLETE** |
| Later month | Feb 3 `JE-1783871559251` DR 5801 / CR 1000 $7,241.67 |

### CB-4 — $781.02 CHARGEBACK ON WELLINGTON (2026-01-02)

| Field | Finding |
|---|---|
| Chargeback JE | `IMP-1783739660051-bc88e4b7` (`je-5729110f-8314-4794-a6aa-edd4c6ab4907`) |
| FITID | `20260102--781-501-242-135` |
| IMP lines | DR 4010 $781.02 / CR 1000 $781.02 |
| After RCLS | net DR 5801 / CR 1000 |
| Bank description | `CHARGEBACK ON WELLINGTON` — **Wellington Insurance**, not a proven borrower name |
| Original payment | **No** pre-chargeback cash receipt of $781.02 in 2026 OFX or journals |
| Later same amount | 2026-02-27 mobile deposit `JE-1783871554719` labeled “Wellington insurance refund” DR 1000 / CR 5300 $781.02 — **after** the chargeback; not the original |
| Servicing allocation | **None** (does not look like ACH loan batch 2638777) |
| Exact undo | **Cannot be written.** If original was an insurance refund (CR 5300), undo would be DR 5300 / CR 1000 — **not proven** for the January chargeback |
| Evidence-match | **INCOMPLETE** |

### CB-5 — $243.80 CHARGEBACK ON WELLINGTON (2026-01-02)

| Field | Finding |
|---|---|
| Chargeback JE | `IMP-1783739659804-40487289` (`je-61a66f3b-5d0a-4f40-a0cb-191ff4232207`) |
| FITID | `20260102--243-501-241-135` |
| IMP lines | DR 4010 $243.80 / CR 1000 $243.80 |
| After RCLS | net DR 5801 / CR 1000 |
| Original payment / borrower / split | **Not found** |
| Later same amount | 2026-04-08 mobile deposit $243.80 — different FITID/date; **not** treated as the original |
| Exact undo | **Cannot be written** |
| Evidence-match | **INCOMPLETE** |

---

## What “undo if never cleared” would require

Chairman example: if original was `DR Cash / CR Interest`, the return should reverse that event (`DR Interest / CR Cash`), not create NSF expense.

| Prerequisite | Status |
|---|---|
| Original cash receipt JE for the same FITID/loan/amount **before** the chargeback | **Missing** for all five |
| Servicing split (interest / principal / fees / escrow) | **Missing** — no matching `loan_tracker_events`; payment_returns have null `loan_id` |
| December 2025 Simmons activity (likely window for the original ACH) | **Not in repo OFX** (file is 2026 only) |

Until those exist, **no reverse-and-repost is authorized.** Posting to 5801 would treat the return as expense without proving the original income/receivable. Leaving the learned 4010 IMP (before RCLS) was also unproven.

Hypothesis only (not a posting basis): the three generic CHARGEBACK amounts recur monthly as NSF and may belong to the ACH 2638777 loan-payment stream; the two Wellington items may be insurance, not borrower NSF. Hypothesis is **not** evidence.

---

## Items left alone (per Chairman)

| Item | Action |
|---|---|
| Lone Star $35 overdraft fees (VR-NSF-003 / 007) | Remain in 5200. Actual bank fees. Duplicate twin JEs already reversed. |
| Unexplained $1,000 | Unresolved. No JE. Do not force-match QBO. |
| Unexplained $532.42 | Unresolved. No January JE equals this amount. No JE. |

---

## A3 status

**Blocked.**

1. Original-payment lineage incomplete for all five.  
2. Full restorable database snapshot not present.  
3. 5801 not approved. 4010 rejected.

**Chairman action required to unblock tracing (not posting):** provide December 2025 Simmons activity and/or loan-servicing NSF records that name borrower, loan, original payment JE, and the P/I/fee split for each of the five amounts.
