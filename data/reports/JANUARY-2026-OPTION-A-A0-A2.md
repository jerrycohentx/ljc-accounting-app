# Option A — A0–A2 (read-only) | January 2026

**Authorization:** A0–A2 only. No A3–A5. No journals posted. No plugs. No rule changes. No recon reopen.

## A0 — Backup restorable?

| Check | Result |
|---|---|
| Save & Exit checkpoints downloadable | YES (`bak-20260812-200229`, plus 2026-08-11 and 2026-08-06) |
| Format | `checkpoint-v1` metadata + row counts only |
| Full encrypted ledger dump (`BACKUP_FULL_LEDGER=1`) | **NOT enabled** — not present |
| Live books durability | Render PostgreSQL (system of record) |

**A0 verdict:** Checkpoints are restorable as *metadata proof-of-save*. A full offline ledger image is **not** currently stored. Postgres remains the durable SOT. Proceeding with A1–A2 is acceptable for *proposal* work; before A3 mutations, Chairman should confirm whether a full ledger snapshot is required.

## A1 — Variance register

Machine-readable register: `data/reports/january-2026-variance-register.json`

### NSF / chargeback family (reviewed separately)

| ID | Date | Amount | Bank description | Current offset | Evidence | Proposed |
|---|---|---:|---|---|---|---|
| VR-NSF-002 | 2026-01-06 | 2,787.50 | CHARGEBACK | DR 4010 | MISMATCH | REV+REPOST → 5801 (pending) |
| VR-NSF-005 | 2026-01-05 | 8,834.17 | CHARGEBACK | DR 4010 | MISMATCH | REV+REPOST → 5801 (pending) |
| VR-NSF-006 | 2026-01-05 | 7,241.67 | CHARGEBACK | DR 4010 | MISMATCH | REV+REPOST → 5801 (pending) |
| VR-NSF-009 | 2026-01-02 | 781.02 | CHARGEBACK ON WELLINGTON | DR 4010 | MISMATCH | REV+REPOST → 5801 (pending) |
| VR-NSF-010 | 2026-01-02 | 243.80 | CHARGEBACK ON WELLINGTON | DR 4010 | MISMATCH | REV+REPOST → 5801 (pending) |
| VR-NSF-003 | 2026-01-05 | 35.00 | OVERDRAFT FEE (Lone Star) | DR 5200 | MATCH | none |
| VR-NSF-007 | 2026-01-02 | 35.00 | OVERDRAFT FEE (Lone Star) | DR 5200 | MATCH | none |
| VR-NSF-004 / 008 | Jan | 35.00 | LoneStar OVERDRAFT twin JEs | — | Already reversed | none |

**Evidence strength:** Five active chargebacks sum to **$19,888.16**, exactly equal to QBO January “NSF payments” (−$19,888.16). Rule path: `Learned: CHARGEBACK` / OFX import.

### Unexplained amounts (not invented)

| ID | Amount | Status |
|---|---:|---|
| VR-UNEX-1000 | 1,000.00 | NEEDS REVIEW — multiple Jan $1,000 transfers exist; Chairman must identify which one |
| VR-UNEX-532.42 | 532.42 | NEEDS REVIEW — **no** January JE totals $532.42 in live books |

## A2 — Proposed corrections

**Withdrawn.** Chairman rejected 4010 and did not approve 5801. Lineage of the original borrower payments is **incomplete** (see `JANUARY-2026-CHARGEBACK-LINEAGE.md`). **No reverse-and-repost is proposed. A3 is not authorized.**

Overdraft fees (VR-NSF-003/007): remain in 5200.  
Unexplained $1,000 and $532.42: unresolved, **no JE**.

## Manageability / Option B

- **NSF/chargeback corrective set (5 items):** manageable under Option A.
- **If scope expands to full January bank/card reclassification:** structurally large → **reconsider Option B**.
- Missing dedicated NSF COA vs QBO “NSF payments” bucket is a chart-design decision for Chairman (5801 used as proposal default only).

## Hard stops honored

No deletes, overwrites, posts, plugs, rule creation, recon reopen, or January data changes in this phase.
