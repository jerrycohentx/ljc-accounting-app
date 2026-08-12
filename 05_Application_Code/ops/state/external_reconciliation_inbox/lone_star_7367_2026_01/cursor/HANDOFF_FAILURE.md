# Phase 1 — Why Cursor could not read Claude’s Lone Star package

**Status:** Claude originals **not found** in any location this Cursor Cloud Agent can read. They were **not** recreated.

## What Claude reported

Claude reported writing and checksum-verifying six files under:

`external_reconciliation_inbox\lone_star_7367_2026_01\`

inside:

`C:\Users\jerry\OneDrive\Cohen Entity Accounting v2`

## What Cursor actually has

| Location | Result |
|---|---|
| GitHub `jerrycohentx/ljc-accounting-app` (this workspace) | No `MANIFEST.sha256`, no `source_manifest.csv`, no Claude conclusions. First files in this path were Cursor’s own `CURSOR_VERIFICATION.md` / `VERIFIED_CORRECTIONS.json` on 2026-08-12. |
| This cloud VM filesystem | No OneDrive mount. `/mnt` is empty. |
| Git history of `master` | Path `05_Application_Code/` did not exist until Cursor created it. |
| Jerry’s other GitHub repos | Only `ljc-accounting-app`. |

## Root cause

**Two different trees.**

1. **Claude (local / Cowork)** wrote to OneDrive `Cohen Entity Accounting v2\05_Application_Code\...` and verified hashes **on that disk**.
2. **Cursor Cloud Agent** clones **GitHub** `ljc-accounting-app`. `AGENTS.md` already says the OneDrive “Cohen Entities Accounting” folder is a shortcut, not the codebase.

Checksum success on OneDrive does not publish bytes to GitHub. Cursor never received those six files.

## If the files still exist

They would still be on Jerry’s PC at the OneDrive path above. This agent cannot open that folder. Valid deposit: copy the **unchanged** files into `ljc-accounting-app` → `05_Application_Code/ops/state/external_reconciliation_inbox/lone_star_7367_2026_01/claude/`, commit, and push.

## What was not done

- Did not invent Claude originals.
- Did not post, reverse, or recertify Lone Star.
