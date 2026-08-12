# Cursor independent verification — Lone Star Bank 7367, January 2026

**Read-only.** No journals posted, reversed, recategorized, reopened, or recertified.

**Fetched:** 2026-08-12T20:25:46.010Z from `https://ljc-accounting-app.onrender.com`  
**Entity:** `ent-ljc`  
**Account:** `1001` Cash - Lone Star Bank (`acc-e323c08d-bcf6-46f5-90a9-b43c900e1b3a`)  
**Statement file named in books:** `LJCckg7367_101007367_statement_01302026_30df.pdf`

---

## 1. Package integrity — FAIL / STOP on Claude’s sources

Claude’s package was **not present** at:

`05_Application_Code/ops/state/external_reconciliation_inbox/lone_star_7367_2026_01/`

Searched this repository, GitHub `jerrycohentx/ljc-accounting-app`, and the agent workspace. **Not found:**

- `MANIFEST.sha256`
- `source_manifest.csv`
- any Claude original conclusions, proposed-reversal list, or hashed source files

**Source integrity of Claude’s package cannot be established. Claude’s files were not used.**

Independent sources used instead (not Claude’s inbox):

| Source | Role | SHA-256 |
|---|---|---|
| `data/bank-imports/LJC/lonestar-2026-statements.json` | Parsed January statement header + 12 lines | `fd33e1e8b256243e24a5019b1c150e36861a084f7ad7d13a941c8e4b82e722be` |
| Live `GET /api/entities/ent-ljc/accounting/periods/integrity?year=2026&month=1` | Period / 1001 recon status | production, 2026-08-12T20:25:46Z |
| Live `GET /api/reconciliation/bank/worksheet?entityId=ent-ljc&accountId=acc-e323c08d-bcf6-46f5-90a9-b43c900e1b3a&statementDate=2026-01-31` | Worksheet Difference | same |
| Live `GET /api/entities/ent-ljc/ledger/account/acc-e323c08d-bcf6-46f5-90a9-b43c900e1b3a?startDate=2025-12-01&endDate=2026-01-31` | Full 1001 register | same |
| Live `GET /api/entities/ent-ljc/reports/transaction-detail?accountNumbers=1001` | Canonical books (excludes reversed + reversing) | same |
| Live `GET /api/entities/ent-ljc/journals/:id` | Full debit/credit, memo, reverse flags | same |

Claude’s original files were not altered (they were not here).

---

## 2. Independent reconciliation — Claude’s $3,607.59 / $2,881.52 **REJECTED**

### Statement (from bundled JSON header + live worksheet)

| Item | Amount | Source |
|---|---:|---|
| Statement beginning | **$598.88** | JSON `meta.previousBalance`; worksheet `beginningBalance` |
| Parsed statement credits (12 lines) | $40,500.87 | JSON `transactions` where amount > 0 |
| Parsed statement debits (12 lines) | $40,373.74 | JSON `transactions` where amount < 0 |
| Parsed line net | $127.13 | JSON `netChange` |
| Header net (ending − beginning) | **$127.19** | $726.07 − $598.88 |
| Line-vs-header gap | **$0.06** | JSON `netVariance` −0.06 |
| Statement ending | **$726.07** | JSON `meta.currentBalance`; worksheet `endingBalance`; `RECONCILIATION_TARGETS` |

The $0.06 is the PDF parser missing (or rounding) January checking interest. Live books already contain `JE-1783784125862` $0.06 dated 2026-01-31, description “Lone Star checking interest (1/31 INTEREST PAID 31 DAYS)”. Worksheet marked deposits $40,500.93 = parsed credits $40,500.87 + $0.06. That is a header-foot gap, not a recon plug to 3900.

**Claude’s statement ending $726.07: CONFIRMED.**

### Books (canonical = posted, not reversed, not reversing — same rule as period integrity)

| Item | Amount | Source |
|---|---:|---|
| Book beginning (as of 2025-12-31) | **$598.88** | transaction-detail as-of 2025-12-31 `grandTotal` |
| Book January cash activity | **+$127.19** | transaction-detail range 2026-01-01..2026-01-31 |
| Book ending (as of 2026-01-31) | **$726.07** | transaction-detail as-of 2026-01-31; full GL also nets to $726.07 |
| Reconciliation difference | **$0.00** | $726.07 − $726.07 |

**Claude’s book ending $3,607.59: REJECTED.**  
**Claude’s difference $2,881.52: REJECTED.**  
($3,607.59 − $726.07 = $2,881.52 is arithmetic on a stale/wrong book figure, not live 1001.)

### Live integrity / worksheet proof (required)

`GET /api/entities/ent-ljc/accounting/periods/integrity?year=2026&month=1`

- `isClosed`: **true**
- `canClose`: **true**
- `closedButCompromised`: **false**
- `blockers`: **none** (`[]`)
- `plugsOrRollupsOk`: **true**
- `netIncomeTieoutOk`: **true**
- Account **1001**: `ok: true`, session `status: CLOSED`, `endingBalance: 726.07`, `difference: 0`, `issue: null`, `closedAt: 2026-07-24T21:50:34.310Z`

`GET /api/reconciliation/bank/worksheet?…&statementDate=2026-01-31`

- `periodSession.balanced`: **true**
- `periodSession.status`: **CLOSED**
- `liveTotals.difference`: **0**
- `liveTotals.clearedBalance`: **726.07**
- `liveTotals.balanced`: **true**
- cleared count: **13**

Lone Star 7367 January is **reconciled** on live production (Cleared = statement = books = $726.07, Difference $0.00). January 2026 as a month is **closed** (`isClosed: true`).

---

## 3. The 14 proposed duplicate reversals

Claude’s 14-item list is **not in the missing package**, so those 14 rows cannot be identified by Claude’s IDs.

Independent register review of **every** January 1001 posting found:

- **13 live (canonical) cash lines** that foot to +$127.19 and match the statement (12 PDF lines + $0.06 interest).
- **Zero** live date+amount duplicates on canonical 1001.
- **12 ingest twins already reversed** on 2026-07-24 (`Reverse duplicate of IMP-… on 1001`).
- **3** mistaken `RESTORE-IMP-…` rows, each already undone with `REV-RESTORE-…`.
- Opening/true-up rows on 2026-01-01, all already reversed; they are not statement activity.

A 14th/15th “proposed reversal” is **not sitting live** on 1001. Approving 14 **new** reversals would reverse the **valid remaining** postings and break a closed $0 recon.

Classification rule used: a twin is a **VERIFIED DUPLICATE** only when two ingest pipelines posted the **same bank event** (same PDF FITID, or Simmons OFX wire + matching Lone Star credit memo for the same interbank move). Date+amount repeat, statement-once, HIGH confidence, or “reversing would make $0” were **not** used as proof.

### 3.1 Twelve historical twins (already reversed — do not reverse again)

Each row below is **VERIFIED DUPLICATE** for **1001 cash only**. Reversal already exists. Net effect of a **new** reversal: **$0** (already applied) or **would break cash** if applied to the live keep-side.

---

#### D01 — 2026-01-02 overdraft $35.00

| | Duplicate (already reversed) | Valid posting (keep) |
|---|---|---|
| Journal | `JE-1783740501830` `je-0d0bde08-d983-4397-9182-4485b54ca4aa` | `IMP-1784868434497-6fb2a399` `je-964c73fe-07ef-4ad3-828b-c015734d89a4` |
| Source / FITID | Catch-up “Jan Lone Star (Bank Service Charges)” — no FITID | PDF `pdf-fcb3bcbded8da507994b3d98` |
| Posting date | 2026-01-02 | 2026-01-02 |
| Created | 2026-07-11T03:28:21.829Z | 2026-07-24T04:47:14.503Z |
| Amount | $35.00 | $35.00 |
| Debit / credit | DR 5200 Bank Service Charges $35.00 / CR 1001 $35.00 | CR 1001 $35.00 / DR 5200 $35.00 |
| Import mechanism | Manual catch-up JE | Statement PDF import |
| Previously reversed? | **Yes** — `REV-JE-1783740501830-1784878847748` | No |
| Bank-statement line | OVERDRAFT FEE 2026-01-02 −$35.00 | same FITID |
| Interbank other side? | No | No |
| Net 1001 if reversed again | Would **add** $35.00 cash (undo the valid fee) | — |

**Classification:** `VERIFIED DUPLICATE` (already reversed).  
**Proposed reversal (already posted):** DR 1001 $35.00 / CR 5200 $35.00.

---

#### D02 — 2026-01-05 overdraft $35.00

| | Duplicate | Valid |
|---|---|---|
| Journal | `JE-1783740502393` `je-0b809484-a7ad-4247-bcef-1ecd791ac379` | `IMP-1784868435190-76f8362e` `je-06fa2c45-07f9-4a9e-adaf-d518c0717c2d` |
| Source / FITID | Catch-up JE, no FITID | PDF `pdf-adadc2178b3e222faca80372` |
| Posting date / created | 2026-01-05 / 2026-07-11T03:28:22.393Z | 2026-01-05 / 2026-07-24T04:47:15.196Z |
| Debit / credit | DR 5200 $35.00 / CR 1001 $35.00 | CR 1001 $35.00 / DR 5200 $35.00 |
| Previously reversed? | **Yes** — `REV-JE-1783740502393-1784878848060` | No |
| Statement line | OVERDRAFT FEE 2026-01-05 −$35.00 | same |
| Interbank? | No | No |

**Classification:** `VERIFIED DUPLICATE` (already reversed).  
**Proposed reversal (already posted):** DR 1001 $35.00 / CR 5200 $35.00.

---

#### D03 — 2026-01-05 Chase EPAY $2,500.00

| | Duplicate | Valid cash posting |
|---|---|---|
| Journal | `JE-1783740503506` `je-2744e3aa-723b-43f6-8000-2081fb8da3f9` | `IMP-1784868434890-e275e77e` `je-fdee681e-f47f-40de-98d4-8153d3fa2c77` |
| Source / FITID | Catch-up “Jan Lone Star (Credit card payment)” | PDF `pdf-96d9d784f0f2ed90c9fa83da` |
| Created | 2026-07-11T03:28:23.512Z | 2026-07-24T04:47:14.897Z |
| Debit / credit | DR 2011 Credit Card - Chase $2,500.00 / CR 1001 $2,500.00 | CR 1001 $2,500.00 / DR 1100 Undeposited Funds $2,500.00 |
| Previously reversed? | **Yes** — `REV-JE-1783740503506-1784878848353` | No |
| Statement line | EPAY CHASE CREDIT CRD 2026-01-05 −$2,500.00 | same |
| Interbank? | No | No |

Same PDF line, two ingest paths. Offset **2011 vs 1100** is a **categorization** difference, not a second cash event. Cash duplicate is verified. Category of the live IMP (1100) is **not** approved as correct — it is not a reason to reverse cash.

**Classification:** `VERIFIED DUPLICATE` for 1001 cash (already reversed).  
**Proposed reversal (already posted):** DR 1001 $2,500.00 / CR 2011 $2,500.00.

---

#### D04 — 2026-01-06 Chase EPAY $3,000.00

| | Duplicate | Valid cash posting |
|---|---|---|
| Journal | `JE-1783740504167` `je-f89b152c-3a74-421d-86d0-f54521aabf43` | `IMP-1784868435397-1195faea` `je-e1d86371-e05d-477e-8cb2-2b94277b6b6e` |
| FITID | none | `pdf-d15a8d23d1c9016c83f93013` |
| Created | 2026-07-11T03:28:24.169Z | 2026-07-24T04:47:15.403Z |
| Debit / credit | DR 2011 $3,000.00 / CR 1001 $3,000.00 | CR 1001 $3,000.00 / DR 1100 $3,000.00 |
| Previously reversed? | **Yes** — `REV-JE-1783740504167-1784878849050` | No |
| Statement line | EPAY CHASE CREDIT CRD 2026-01-06 −$3,000.00 | same |

**Classification:** `VERIFIED DUPLICATE` for 1001 cash (already reversed).  
**Proposed reversal (already posted):** DR 1001 $3,000.00 / CR 2011 $3,000.00.

---

#### D05 — 2026-01-05 inbound $2,500.00 (Simmons wire = Lone Star credit memo)

| | Duplicate (PDF LOC posting) | Valid posting (interbank) |
|---|---|---|
| Journal | `IMP-1784868432890-1c5c6881` `je-2fb9ca55-bd8f-498d-8d16-4831150048fe` | `IMP-1783739660429-10093376` `je-27471b6c-9c6a-42cb-b9de-81979accb53a` |
| Source | LSB PDF FITID `pdf-23f4d76d3ac2677469b5a80c` “DDA Credit Memo” / rule LOC advance | Simmons OFX FITID `20260105--2500-804-2922-111` “WIRE TRANSFER DEBIT LJC FINANCIA WIR” / rule **Wire to Lone Star** |
| Created | 2026-07-24T04:47:12.896Z | 2026-07-11T03:14:20.428Z |
| Debit / credit | DR 1001 $2,500.00 / CR 2120 LOC $2,500.00 | **CR 1000 Simmons $2,500.00 / DR 1001 $2,500.00** |
| Previously reversed? | **Yes** — `REV-IMP-1784868432890-1c5c6881-1784878848152` (then a RESTORE was posted and undone) | No |
| Statement line | DDA Credit Memo 2026-01-05 +$2,500.00 | Same cash in; OFX is the Simmons side of the transfer |
| Interbank other side? | **No** — this was a second 1001 debit of the same inbound wire, mislabeled LOC | **Yes** — legitimate Simmons → Lone Star transfer |

Independent evidence beyond date/amount: Simmons OFX wire-to-Lone-Star **and** Lone Star statement credit memo, same day, same $2,500.00. One cash-in on 1001.

**Classification:** `VERIFIED DUPLICATE` of 1001 cash (already reversed).  
**Proposed reversal (already posted):** CR 1001 $2,500.00 / DR 2120 $2,500.00.

---

#### D06 — 2026-01-06 inbound $3,000.00 (same interbank pattern)

| | Duplicate | Valid (interbank) |
|---|---|---|
| Journal | `IMP-1784868433191-d77f22a6` `je-c0b9533e-b4cc-4d56-abe3-a7896e2f636c` | `IMP-1783739661280-4219a6b3` `je-de37917e-bacc-4cb4-a03c-c2e8887b81b5` |
| FITID | `pdf-ecf70c7329ed5a0b6db640ae` | OFX `20260106--3000-804-2174-111` |
| Debit / credit | DR 1001 $3,000.00 / CR 2120 $3,000.00 | CR 1000 $3,000.00 / DR 1001 $3,000.00 |
| Previously reversed? | **Yes** — `REV-IMP-1784868433191-d77f22a6-1784878848455` (+ RESTORE undone) | No |
| Interbank? | Second 1001 hit of the same wire | **Yes** — Simmons → Lone Star |

**Classification:** `VERIFIED DUPLICATE` (already reversed).  
**Proposed reversal (already posted):** CR 1001 $3,000.00 / DR 2120 $3,000.00.

---

#### D07 — 2026-01-13 inbound $4,700.00 (same interbank pattern)

| | Duplicate | Valid (interbank) |
|---|---|---|
| Journal | `IMP-1784868433491-d07f9b69` `je-5e5ef128-e965-40f9-8096-1aa690486f3b` | `IMP-1783739662220-8f1d75fe` `je-57701a04-4e9b-4c93-a7bc-83f2f2523ece` |
| FITID | `pdf-36dcf0107f88557dff9dc8f4` | OFX `20260113--4700-804-1990-111` |
| Debit / credit | DR 1001 $4,700.00 / CR 2120 $4,700.00 | CR 1000 $4,700.00 / DR 1001 $4,700.00 |
| Previously reversed? | **Yes** — `REV-IMP-1784868433491-d07f9b69-1784878849249` (+ RESTORE undone) | No |
| Interbank? | Second 1001 hit | **Yes** — Simmons → Lone Star |

**Classification:** `VERIFIED DUPLICATE` (already reversed).  
**Proposed reversal (already posted):** CR 1001 $4,700.00 / DR 2120 $4,700.00.

---

#### D08 — 2026-01-13 DDA Credit Memo $29,575.00

| | Duplicate | Live cash posting (keep; **classification unresolved**) |
|---|---|---|
| Journal | `JE-1783740499398` `je-251d7b00-dd57-42f5-a6de-bf1f50716102` | `IMP-1784868433796-38b01618` `je-81a372ed-e57a-4c98-9def-dd049905d66c` |
| Source | Catch-up “Jan Lone Star (Loan payoff / deposit)” | PDF `pdf-88497870f0a5f28a8f91b599` / rule LOC advance |
| Created | 2026-07-11T03:28:19.397Z | 2026-07-24T04:47:13.802Z |
| Debit / credit | DR 1001 $29,575.00 / CR 1300 Notes Receivable $29,575.00 | DR 1001 $29,575.00 / CR 2120 LOC $29,575.00 |
| Previously reversed? | **Yes** — `REV-JE-1783740499398-1784878849758` | No |
| Statement line | DDA Credit Memo 2026-01-13 +$29,575.00 | same FITID |
| Interbank? | Not established | Not established |

Two ingest paths of the **same PDF line** → cash duplicate verified. **What the memo is** (LOC vs notes receivable vs something else) is **not** established from independent source documents. Left unresolved per instruction. Do **not** reverse the live IMP.

**Classification:** `VERIFIED DUPLICATE` for the catch-up JE only (already reversed). Live IMP: **NEEDS REVIEW** for offset, not for cash existence.  
**Proposed reversal of the JE (already posted):** CR 1001 $29,575.00 / DR 1300 $29,575.00.

---

#### D09 — 2026-01-13 DDA Debit Memo $29,575.00

| | Duplicate | Live cash posting (keep; **classification unresolved**) |
|---|---|---|
| Journal | `JE-1783740499998` `je-755a78f0-6e5e-4d94-8e9a-f85780ea0a21` | `IMP-1784868435888-b4354af2` `je-3203214c-c1d6-4d2b-925b-42115bf3a39c` |
| Source | Catch-up “Jan Lone Star (Loan funding / disbursement)” | PDF `pdf-5452b17568954abc4523c4c3` / rule LOC paydown |
| Created | 2026-07-11T03:28:19.998Z | 2026-07-24T04:47:15.894Z |
| Debit / credit | DR 1300 $29,575.00 / CR 1001 $29,575.00 | CR 1001 $29,575.00 / DR 2120 $29,575.00 |
| Previously reversed? | **Yes** — `REV-JE-1783740499998-1784878849777` | No |
| Statement line | DDA DEBIT MEMO 2026-01-13 −$29,575.00 | same |
| Interbank? | Not established | Not established |

Cash in and cash out on 13 Jan **net $0.00** on 1001 and match the statement pair. Offset 2120 vs 1300 remains **unresolved**.

**Classification:** `VERIFIED DUPLICATE` for the catch-up JE (already reversed). Live IMP: **NEEDS REVIEW** for offset.  
**Proposed reversal of the JE (already posted):** DR 1001 $29,575.00 / CR 1300 $29,575.00.

---

#### D10 — 2026-01-15 loan payment $2,019.74

| | Duplicate | Live cash posting (keep; **allocation unresolved**) |
|---|---|---|
| Journal | `JE-1783740500603` `je-73ecb881-d9f6-4293-9e68-ce8c4e0bd128` | `IMP-1784868436888-f53d43b4` `je-8179d102-97c6-4521-8f22-86b8a495ee24` |
| Source | Catch-up “Jan Lone Star (Lending deposits / collections)” | PDF `pdf-8df317a6c24fd902934e994f` / rule WLOC payment |
| Created | 2026-07-11T03:28:20.602Z | 2026-07-24T04:47:16.895Z |
| Debit / credit | DR 1300 $2,019.74 / CR 1001 $2,019.74 | CR 1001 $2,019.74 / DR 2130 WLOC $2,019.74 |
| Previously reversed? | **Yes** — `REV-JE-1783740500603-1784878849848` | No |
| Statement line | LOAN PAYMENT 2026-01-15 −$2,019.74 | same |
| Interbank? | No | No |

Same PDF line twice → cash duplicate verified. **Principal vs interest split is not in the statement line or either journal.** Neither 1300-all nor 2130-all is independently evidenced. Left unresolved. Do **not** reverse the live IMP.

**Classification:** `VERIFIED DUPLICATE` for the catch-up JE (already reversed). Live IMP allocation: **NEEDS REVIEW**.  
**Proposed reversal of the JE (already posted):** DR 1001 $2,019.74 / CR 1300 $2,019.74.

---

#### D11 — 2026-01-16 DDA Debit Memo $3,209.00

| | Duplicate | Live cash posting (keep; **treatment unresolved**) |
|---|---|---|
| Journal | `JE-1783740501270` `je-e07fd5b1-2aeb-4813-9747-d610fb82879c` | `IMP-1784868437189-2cb3a760` `je-67a73773-1b58-4b6c-8c44-ca9f2daa5e12` |
| Source | Catch-up “Jan Lone Star (Loan funding / disbursement)” | PDF `pdf-2dbbdc208ba65492ad1edbbc` / rule LOC paydown |
| Created | 2026-07-11T03:28:21.269Z | 2026-07-24T04:47:17.195Z |
| Debit / credit | DR 1300 $3,209.00 / CR 1001 $3,209.00 | CR 1001 $3,209.00 / DR 2120 $3,209.00 |
| Previously reversed? | **Yes** — `REV-JE-1783740501270-1784878850048` | No |
| Statement line | DDA DEBIT MEMO 2026-01-16 −$3,209.00 | same |
| Interbank? | Not established | Not established |

Cash duplicate of the same PDF line verified. **What the debit memo is** is not established. Left unresolved. Do **not** reverse the live IMP.

**Classification:** `VERIFIED DUPLICATE` for the catch-up JE (already reversed). Live IMP treatment: **NEEDS REVIEW**.  
**Proposed reversal of the JE (already posted):** DR 1001 $3,209.00 / CR 1300 $3,209.00.

---

#### D12 — 2026-01-23 C.D. interest $725.87

| | Duplicate | Valid |
|---|---|---|
| Journal | `JE-1783740502964` `je-f1477e68-20e6-496e-919b-609eaa85dc9d` | `IMP-1784868434190-33d01b50` `je-0dcbb3f5-e7e8-45e1-9ec7-599bf7235229` |
| Source | Catch-up “Jan Lone Star (Interest income)” | PDF `pdf-55135681b280ae47bd4dd868` |
| Created | 2026-07-11T03:28:22.963Z | 2026-07-24T04:47:14.196Z |
| Debit / credit | DR 1001 $725.87 / CR 4000 $725.87 | DR 1001 $725.87 / CR 4000 $725.87 |
| Previously reversed? | **Yes** — `REV-JE-1783740502964-1784878850348` | No |
| Statement line | C.D. INTEREST 2026-01-23 +$725.87 | same |
| Interbank? | No | No |

**Classification:** `VERIFIED DUPLICATE` (already reversed).  
**Proposed reversal (already posted):** CR 1001 $725.87 / DR 4000 $725.87.

---

### 3.2 Items that are **NOT** duplicates (live canonical register)

These are the 13 live 1001 lines. None should be reversed as “duplicates.”

| Date | Journal | 1001 signed | Statement line | Note |
|---|---|---:|---|---|
| 2026-01-02 | `IMP-1784868434497-6fb2a399` | −35.00 | OD fee | Keep |
| 2026-01-05 | `IMP-1783739660429-10093376` | +2,500.00 | DDA Credit Memo $2,500 (via Simmons OFX) | Interbank keep |
| 2026-01-05 | `IMP-1784868434890-e275e77e` | −2,500.00 | Chase EPAY | Keep cash; offset 1100 is categorization |
| 2026-01-05 | `IMP-1784868435190-76f8362e` | −35.00 | OD fee | Keep |
| 2026-01-06 | `IMP-1783739661280-4219a6b3` | +3,000.00 | DDA Credit Memo $3,000 (via Simmons OFX) | Interbank keep |
| 2026-01-06 | `IMP-1784868435397-1195faea` | −3,000.00 | Chase EPAY | Keep cash |
| 2026-01-13 | `IMP-1783739662220-8f1d75fe` | +4,700.00 | DDA Credit Memo $4,700 (via Simmons OFX) | Interbank keep |
| 2026-01-13 | `IMP-1784868433796-38b01618` | +29,575.00 | DDA Credit Memo $29,575 | Cash keep; offset **NEEDS REVIEW** |
| 2026-01-13 | `IMP-1784868435888-b4354af2` | −29,575.00 | DDA Debit Memo $29,575 | Cash keep; offset **NEEDS REVIEW** |
| 2026-01-15 | `IMP-1784868436888-f53d43b4` | −2,019.74 | LOAN PAYMENT | Cash keep; P/I **NEEDS REVIEW** |
| 2026-01-16 | `IMP-1784868437189-2cb3a760` | −3,209.00 | DDA Debit Memo $3,209 | Cash keep; treatment **NEEDS REVIEW** |
| 2026-01-23 | `IMP-1784868434190-33d01b50` | +725.87 | C.D. INTEREST | Keep |
| 2026-01-31 | `JE-1783784125862` | +0.06 | Header-vs-lines $0.06 interest | Keep; not a duplicate |

Sum of 1001 signed = **+$127.19**.

### 3.3 Three unresolved matters (per instruction — no inference)

1. **January 15 loan payment $2,019.74** — cash is on the statement once and booked once (live IMP). Principal/interest split is **not** in the PDF line. Not estimated.
2. **January 16 $3,209 debit memo** — cash is on the statement once and booked once. Nature of the memo is **not** in independent source evidence beyond the PDF description “DDA DEBIT MEMO” and a learned LOC-paydown rule. Not inferred.
3. **January 13 $29,575 credit and $29,575 debit** — both statement lines exist; both are booked once on live 1001; they net $0.00 cash. Offsets currently 2120/2120. Catch-up JEs used 1300 and are already reversed. Treatment **not** independently established.

---

## 4. Recalculated reconciliation (no plug)

### 4.1 As currently booked

```
Statement beginning     $    598.88
Statement activity      $    127.19   (header; lines $127.13 + $0.06 interest)
Statement ending        $    726.07

Book beginning          $    598.88
Book January activity   $    127.19
Book ending             $    726.07

Difference              $      0.00
```

Live worksheet: `periodSession.balanced === true`, `liveTotals.difference === 0`.

### 4.2 After only VERIFIED DUPLICATE reversals

Those 12 reversals are **already on the books** (July 24). Applying them again is not a correction; it would reverse the **keep** side or fail as already-reversed.

```
Book ending after verified-duplicate reversals (current state)  $726.07
Difference                                                      $  0.00
```

Hypothetical: if the 12 keep-side live journals were reversed instead, 1001 January cash would no longer match the statement and Difference would no longer be $0.00. That path is rejected.

### 4.3 Excluding all NEEDS REVIEW items from proposed correction

NEEDS REVIEW items are **offsets/allocations**, not missing/extra 1001 cash. Excluding them from correction leaves cash unchanged:

```
Book ending     $726.07
Difference      $  0.00
```

No plug. No force-to-zero. Live difference is already zero.

---

## 5. Recommendation — Chairman approval of the 14 proposed corrections

**Not safe. Do not approve.**

1. Claude’s inbox hashes cannot be verified (package missing).
2. Claude’s book ending **$3,607.59** and difference **$2,881.52** are **false** against live 1001.
3. Live Lone Star 7367 January is already **reconciled** at **$726.07 / $0.00** and the month is **`isClosed: true`**.
4. The only verified 1001 cash duplicates are **12 ingest twins that are already reversed**. A 14th/15th live duplicate was not found.
5. New reversals would mutate a closed $0 recon. The three named allocation/memo questions remain open and must not be “solved” by reversing cash.

**STOP. No accounting mutation.**
