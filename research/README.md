# Analysis research bench

Offline Python bench for prototyping and calibrating analysis metrics before the
deterministic formulas are hardened into the Go builder (`cmd/player-analysis-build`).
This code never ships in the desktop/web product (Go stdlib + native ES Modules only).
Plan and status: [`docs/player-analysis-roadmap.md`](../docs/player-analysis-roadmap.md).

## Bootstrap on a fresh machine

The whole pipeline is deterministic, so a new machine reproduces the exact analysis
state from source + code:

1. `git clone` the repo (Git LFS pulls `huashan-export.sql.gz`).
2. Start a local MySQL 8.4 server (see memory / roadmap Phase 0 for the portable-server
   commands) on `127.0.0.1:3306`, root, no password.
3. Import the dump: `gunzip -c huashan-export.sql.gz | mysql -h127.0.0.1 -u root`.
4. Rebuild derived tables: `go run ./cmd/player-analysis-build -rebuild`.
5. Install bench deps: `pip install -r research/requirements.txt`.
6. Verify: `cd research && python sanity_check.py`.

Override the DB target with `HUASHAN_DSN` (a SQLAlchemy URL) if not using the default.

## What is and isn't committed

- **Committed:** these scripts, `requirements.txt`, and the source dump (via LFS).
- **Not committed (regenerate):** the MySQL `analysis_*` tables and everything under
  `research/output/` (caches, plots, model files). Reproduce them by re-running the
  builder and scripts — never hand-edit derived state.
