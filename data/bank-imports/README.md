# Bank imports for 2026 catch-up

Drop Simmons / Lone Star **OFX (Web Connect)** exports here. The catch-up script scans all subfolders.

## Required for LJC Financial (ent-ljc)

| File (suggested name) | Account | Period |
|----------------------|---------|--------|
| `LJC/Simmons_ckg_0260_2026-01.ofx` | 1000 | Jan 2026 |
| `LJC/Simmons_ckg_0260_2026-02.ofx` | 1000 | Feb 2026 |
| … through current month | 1000 | Mar–Jun 2026 |

**January reconciliation target (already configured):** statement date **2026-02-01**, ending balance **$15,880.28**.

## Run after adding files

```bash
node scripts/catch-up-2026.js --full
```

Or step by step: `--close-2025` → `--import-all` → `--post-all` → `--reconcile` → `--status`

## Other entities

If Justin, OMC, Graceful Meadows, QOF, or 4J&L had 2026 bank activity, add their OFX exports with entity name in the filename (e.g. `Justin_2026-01.ofx`).
