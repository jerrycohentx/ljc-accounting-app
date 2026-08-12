# External reconciliation inbox (Claude → Cursor)

**Canonical shared location is this git repo**, not OneDrive.

```
05_Application_Code/ops/state/external_reconciliation_inbox/<bank>_<last4>_<yyyy>_<mm>/
  claude/     Claude only. Immutable during Cursor verification.
  cursor/     Cursor only. Verification, intake result, LJCOS snapshot.
```

OneDrive `C:\Users\jerry\OneDrive\Cohen Entity Accounting v2\...` is **not** visible to Cursor Cloud Agents. Writing there and checksumming locally is not a handoff.

## Claude (deposit)

1. Create `claude/` in the bank/month folder **in `ljc-accounting-app` on GitHub**.
2. Put source PDFs/JSON, `source_manifest.csv`, `MANIFEST.sha256`, optional `CLAUDE_CONCLUSIONS.json` and `PROPOSED_CORRECTIONS.json`.
3. `MANIFEST.sha256` is `sha256sum` format (`<hex>  <filename>`), covering every Claude file except Cursor output.
4. Commit and push to the branch Cursor will clone. Do not only write to OneDrive.

## Cursor (intake)

```bash
node scripts/verify-external-reconciliation-inbox.mjs --package lone_star_7367_2026_01 --capture-ljcos
```

- Exit **2** = hard STOP (missing file, hash mismatch, already-reversed journal).
- Exit **0** = bytes match. Claude conclusions remain **UNVERIFIED**.
- Writes `cursor/INTAKE_RESULT.json` and, with `--capture-ljcos`, `cursor/LJCOS_SNAPSHOT.json`.
- Never writes into `claude/`.
- Never posts, reverses, or recategorizes.

## Rules

1. Same git bytes for Claude and Cursor.
2. Verify `MANIFEST.sha256` before analysis.
3. Verify `source_manifest.csv` hashes.
4. Claude files immutable during verification.
5. Cursor writes separate files only.
6. Missing/mismatch → STOP.
7. Claude conclusions = UNVERIFIED until checked against current LJCOS.
8. Capture current LJCOS recon/ledger **before** evaluating proposed corrections.
9. Already-reversed journals cannot be proposed for reversal again.
