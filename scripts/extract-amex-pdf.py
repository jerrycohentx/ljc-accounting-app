#!/usr/bin/env python3
"""Extract American Express business card statement transactions from PDF → JSON."""
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

PAYMENT_LINE = re.compile(
    r"^(\d{2}/\d{2}/\d{2})\*?\s+JEREMY S COHEN\s+(.+?)\s+(-?\$[\d,]+\.\d{2})\s*$"
)
INTEREST_LINE = re.compile(
    r"^(\d{2}/\d{2}/\d{2})\s+(Interest Charge on Purchases)\s+\$([\d,]+\.\d{2})\s*$"
)
CREDIT_AMOUNT = re.compile(r"^(-?\$[\d,]+\.\d{2})$")
CREDIT_START = re.compile(r"^(\d{2}/\d{2}/\d{2})\s+JEREMY S COHEN\s+(.+)$")
AMOUNT_LINE = re.compile(r"^\$([\d,]+\.\d{2})$")
SUMMARY = re.compile(
    r"Previous Balance\s+Payments/Credits\s+New Charges\s+Fees\s+Interest Charged\s+"
    r"\$([\d,]+\.\d{2})\s+(-?\$[\d,]+\.\d{2})\s+\+\$([\d,]+\.\d{2})\s+\+\$([\d,]+\.\d{2})\s+\+\$([\d,]+\.\d{2})",
    re.S,
)


def parse_amount(s: str) -> float:
    return float(s.replace("$", "").replace(",", "").strip())


def normalize_date(mdyy: str) -> str:
    m, d, y = mdyy.split("/")
    y = int(y)
    if y < 100:
        y += 2000
    return f"{y:04d}-{int(m):02d}-{int(d):02d}"


def fitid(date: str, amount: float, desc: str) -> str:
    key = f"{date}|{amount:.2f}|{desc[:80]}"
    return "amex-" + sha256(key.encode()).hexdigest()[:24]


def make_txn(date: str, amount: float, description: str) -> dict:
    return {
        "date": date,
        "amount": round(amount, 2),
        "description": description.strip(),
        "fitid": fitid(date, amount, description),
        "isPayment": amount < 0,
    }


def parse_metadata(text: str) -> dict:
    meta = {}
    m = re.search(r"Closing Date (\d{2}/\d{2}/\d{2})", text)
    if m:
        meta["closingDate"] = normalize_date(m.group(1))
    m = re.search(r"New Balance \$([\d,]+\.\d{2})", text)
    if m:
        meta["newBalance"] = parse_amount(m.group(1))
    sm = SUMMARY.search(text)
    if sm:
        meta["previousBalance"] = parse_amount(sm.group(1))
        meta["paymentsCredits"] = parse_amount(sm.group(2))
        meta["newCharges"] = parse_amount(sm.group(3))
        meta["fees"] = parse_amount(sm.group(4))
        meta["interestCharged"] = parse_amount(sm.group(5))
    meta["accountLast4"] = "88007"
    meta["cardName"] = "Amex Marriott Bonvoy Business 88007"
    return meta


def parse_credits(text: str) -> list:
    txns = []
    lines = text.splitlines()
    in_credits = False
    pending = None
    for raw in lines:
        line = raw.strip()
        if line == "Credits Amount":
            in_credits = True
            continue
        if in_credits and line.startswith("New Charges"):
            break
        if not in_credits:
            continue
        cm = CREDIT_START.match(line)
        if cm:
            pending = {"date": normalize_date(cm.group(1)), "desc": cm.group(2).strip()}
            continue
        am = CREDIT_AMOUNT.match(line)
        if am and pending:
            amount = parse_amount(am.group(1))
            txns.append(make_txn(pending["date"], amount, f"Credit: {pending['desc']}"))
            pending = None
    return txns


def parse_transactions(text: str) -> list:
    txns = parse_payments(text)
    txns.extend(parse_credits(text))
    txns.extend(parse_charges(text))
    return dedupe(txns)


def parse_payments(text: str) -> list:
    txns = []
    for raw in text.splitlines():
        line = raw.strip()
        pm = PAYMENT_LINE.match(line)
        if pm:
            txns.append(
                make_txn(
                    normalize_date(pm.group(1)),
                    parse_amount(pm.group(3)),
                    pm.group(2).strip(),
                )
            )
    return txns


def parse_charges(text: str) -> list:
    txns = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        i += 1
        if not line:
            continue

        im = INTEREST_LINE.match(line)
        if im:
            txns.append(
                make_txn(
                    normalize_date(im.group(1)),
                    parse_amount(im.group(3)),
                    im.group(2),
                )
            )
            continue

        cm = re.match(r"^(\d{2}/\d{2}/\d{2})\s+(.+)$", line)
        if not cm:
            continue
        date_raw, rest = cm.group(1), cm.group(2)
        if "Closing Date" in rest or "Account Ending" in rest or rest.startswith("JEREMY S COHEN"):
            continue
        if "PAYMENT" in rest.upper() and "$" in rest:
            continue
        if rest in ("Amount", "Detail", "Detail Continued", "Credits Amount", "Payments Amount"):
            continue

        amount = None
        desc_parts = [rest]
        j = i
        while j < len(lines) and j < i + 4:
            nxt = lines[j].strip()
            am = AMOUNT_LINE.match(nxt)
            if am:
                amount = parse_amount(am.group(1))
                i = j + 1
                break
            if re.match(r"^(\d{2}/\d{2}/\d{2})\s+", nxt) or PAYMENT_LINE.match(nxt) or INTEREST_LINE.match(nxt):
                break
            if nxt and not nxt.startswith("p. ") and nxt != "Continued on reverse":
                desc_parts.append(nxt)
            j += 1
        if amount is None:
            continue
        desc = " ".join(desc_parts)
        if "Interest Charge" in desc:
            continue
        txns.append(make_txn(normalize_date(date_raw), amount, desc))

    return txns


def dedupe(txns: list) -> list:
    seen = {}
    out = []
    for t in txns:
        fid = t["fitid"]
        if fid in seen:
            seen[fid] += 1
            fid = f"{fid}-{seen[fid]}"
        else:
            seen[fid] = 1
        out.append({**t, "fitid": fid})
    return out


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: extract-amex-pdf.py file.pdf"}))
        sys.exit(1)
    pdf_path = sys.argv[1]
    text = "\n".join((p.extract_text() or "") for p in PdfReader(pdf_path).pages)
    if "americanexpress.com" not in text.lower() and "AMERICAN EXPRESS" not in text:
        print(json.dumps({"error": "not an Amex statement", "file": pdf_path}))
        sys.exit(1)
    meta = parse_metadata(text)
    txns = parse_transactions(text)
    net = round(sum(t["amount"] for t in txns), 2)
    result = {
        "file": str(Path(pdf_path).name),
        "meta": meta,
        "transactionCount": len(txns),
        "netChange": net,
        "transactions": txns,
    }
    if meta.get("previousBalance") is not None and meta.get("newBalance") is not None:
        expected = round(meta["previousBalance"] + net, 2)
        result["expectedNet"] = round(meta["newBalance"] - meta["previousBalance"], 2)
        result["netVariance"] = round(net - result["expectedNet"], 2)
        result["expectedClosing"] = meta["newBalance"]
    print(json.dumps(result))


if __name__ == "__main__":
    main()
