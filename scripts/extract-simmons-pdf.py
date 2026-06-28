#!/usr/bin/env python3
"""Extract Simmons bank statement transactions from PDF → JSON."""
import json
import re
import sys
from hashlib import sha256
from pathlib import Path

try:
    from pypdf import PdfReader
except ImportError:
    print(json.dumps({"error": "pypdf not installed"}))
    sys.exit(1)


def extract_text(pdf_path: str) -> str:
    reader = PdfReader(pdf_path)
    parts = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    return "\n".join(parts)


def parse_amount(s: str) -> float:
    s = s.replace(",", "").strip().rstrip("-")
    return float(s)


def parse_metadata(text: str) -> dict:
    meta = {}
    m = re.search(
        r"Statement Dates\s+(\d{1,2}/\d{1,2}/\d{2,4})\s+thru\s+(\d{1,2}/\d{1,2}/\d{2,4})",
        text,
        re.I,
    )
    if m:
        meta["periodStart"] = normalize_date(m.group(1))
        meta["periodEnd"] = normalize_date(m.group(2))
    m = re.search(r"Previous Balance\s+([\d,]+\.\d{2})", text)
    if m:
        meta["previousBalance"] = parse_amount(m.group(1))
    m = re.search(r"Current Balance\s+([\d,]+\.\d{2})", text)
    if m:
        meta["currentBalance"] = parse_amount(m.group(1))
    m = re.search(r"Ending Balance\s+([\d,]+\.\d{2})", text)
    if m and "currentBalance" not in meta:
        meta["currentBalance"] = parse_amount(m.group(1))
    m = re.search(r"Account Number X+(\d{4})", text)
    if m:
        meta["accountLast4"] = m.group(1)
    m = re.search(r"Account Number\s+Ending\s+(\d{4})", text, re.I)
    if m and "accountLast4" not in meta:
        meta["accountLast4"] = m.group(1)
    if meta.get("accountLast4") == "7367":
        meta["bankName"] = "Lone Star Bank"
    elif meta.get("accountLast4") == "0260":
        meta["bankName"] = "Simmons Bank"
    return meta


def normalize_date(mdyy: str) -> str:
    parts = mdyy.strip().split("/")
    if len(parts) != 3:
        return mdyy
    m, d, y = parts
    y = int(y)
    if y < 100:
        y += 2000
    return f"{y:04d}-{int(m):02d}-{int(d):02d}"


def infer_year(text: str, md: str) -> str:
    """md is M/D without year."""
    meta = parse_metadata(text)
    if meta.get("periodStart"):
        return meta["periodStart"][:4]
    return "2026"


def md_to_iso(text: str, md: str) -> str:
    m, d = md.split("/")
    year = infer_year(text, md)
    return f"{year}-{int(m):02d}-{int(d):02d}"


TXN_LINE = re.compile(
    r"^(\d{1,2}/\d{1,2})\s+(.+?)\s+([\d,]+\.\d{2})(-?)\s*$"
)
CHECK_GRID = re.compile(
    r"(\d{1,2}/\d{1,2})\s+(?:(\d{5,7})\*?\s+)?([\d,]+\.\d{2})(-?)"
)


def parse_check_grid_line(text: str, line: str) -> list:
    """Parse '1/09 1,218.75 1/21 29,623.93' style rows."""
    txns = []
    for m in CHECK_GRID.finditer(line):
        date = md_to_iso(text, m.group(1))
        check_no = m.group(2)
        amt = parse_amount(m.group(3))
        if m.group(4) == "-":
            amt = -amt
        else:
            amt = -abs(amt)
        desc = f"Check #{check_no}" if check_no else "Check"
        txns.append(make_txn(date, amt, desc))
    return txns

SKIP_PREFIXES = (
    "Date ", "Primary Account", "Commercial Checking", "CHECKING",
    "Deposits and Additions", "Checks and Withdrawals", "CHECKS IN NUMBER",
    "Daily Balance", "Thank you", "END OF STATEMENT", "Deposit Date",
    "Check Date", "STATE ", "RECONCILEMENT", "Previous Balance",
    "Enclosures", "Ljc Financial", "PO Box", "Houston", "Commercial Checking TM",
    "* Denotes", "Page ", "MAY 2026", "P O Box", "OFFICER:",
)


def should_skip(line: str) -> bool:
    line = line.strip()
    if not line or len(line) < 5:
        return True
    for p in SKIP_PREFIXES:
        if line.startswith(p):
            return True
    if re.match(r"^[\d/]+\s+[\d,]+\.\d{2}\s+[\d/]", line):  # daily balance grid
        return True
    return False


def fitid(date: str, amount: float, desc: str) -> str:
    key = f"{date}|{amount:.2f}|{desc[:80]}"
    return "pdf-" + sha256(key.encode()).hexdigest()[:24]


def parse_transactions(text: str) -> list:
    txns = []
    in_deposits = False
    in_withdrawals = False
    in_checks = False

    for raw in text.splitlines():
        line = raw.strip()
        if "Deposits and Additions" in line:
            in_deposits = True
            in_withdrawals = False
            in_checks = False
            continue
        if "Checks and Withdrawals" in line:
            in_withdrawals = True
            in_deposits = False
            in_checks = False
            continue
        if "CHECKS IN NUMBER ORDER" in line:
            in_checks = True
            in_deposits = False
            in_withdrawals = False
            continue
        if "Daily Balance Information" in line:
            in_deposits = in_withdrawals = in_checks = False
            continue
        if should_skip(line) and not in_checks:
            continue
        if re.match(r"^(Deposit|Check)\s+Date:", line, re.I):
            continue

        if in_checks:
            grid = parse_check_grid_line(text, line)
            if grid:
                txns.extend(grid)
                continue

        m = TXN_LINE.match(line)
        if not m:
            continue
        date = md_to_iso(text, m.group(1))
        desc = m.group(2).strip()
        amt = parse_amount(m.group(3))
        is_debit = m.group(4) == "-" or in_withdrawals
        if in_deposits and not is_debit:
            amt = abs(amt)
        elif in_withdrawals or is_debit:
            amt = -abs(amt)
        else:
            # deposits section but no trailing minus
            if "Credit" in desc or "Deposit" in desc or "Transfer CH" in desc or "LeanneRent" in desc or "Rent " in desc or "ACH BATCH" in desc or "ACH Pmt" in desc or "PAYMENT" in desc or "Wire Transfer Credit" in desc:
                amt = abs(amt)
            elif "Debit" in desc or "Chargeback" in desc or "ACH PMT" in desc or "Wire Transfer Debit" in desc:
                amt = -abs(amt)
            elif in_deposits:
                amt = abs(amt)
            else:
                amt = -abs(amt)

        if desc.lower().startswith("date "):
            continue
        txns.append(make_txn(date, amt, desc))

    return dedupe_txns(txns)


def make_txn(date: str, amount: float, description: str) -> dict:
    return {
        "date": date,
        "amount": round(amount, 2),
        "description": description,
        "fitid": fitid(date, amount, description),
        "isCredit": amount > 0,
    }


def dedupe_txns(txns: list) -> list:
    seen = {}
    out = []
    for t in txns:
        fid = t["fitid"]
        if fid in seen:
            seen[fid] += 1
            fid = f"{fid}-{seen[fid]}"
        else:
            seen[fid] = 1
        t = {**t, "fitid": fid}
        out.append(t)
    return out


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: extract-simmons-pdf.py file.pdf"}))
        sys.exit(1)
    pdf_path = sys.argv[1]
    text = extract_text(pdf_path)
    if "CHECKING ACCOUNTS" not in text and "Current Balance" not in text and "Ending Balance" not in text:
        print(json.dumps({"error": "not a supported checking statement", "file": pdf_path}))
        sys.exit(1)
    meta = parse_metadata(text)
    txns = parse_transactions(text)
    net = sum(t["amount"] for t in txns)
    result = {
        "file": str(Path(pdf_path).name),
        "meta": meta,
        "transactionCount": len(txns),
        "netChange": round(net, 2),
        "transactions": txns,
    }
    if meta.get("previousBalance") is not None and meta.get("currentBalance") is not None:
        result["expectedNet"] = round(meta["currentBalance"] - meta["previousBalance"], 2)
        result["netVariance"] = round(net - result["expectedNet"], 2)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
