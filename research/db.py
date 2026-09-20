"""Shared MySQL connection helper for offline analysis research.

Read-only usage against the local `huashan` database rebuilt by
`cmd/player-analysis-build` (see docs/player-analysis-roadmap.md, Phase 1).

DSN resolution order:
  1. env var HUASHAN_DSN (SQLAlchemy URL)
  2. local default: root@127.0.0.1:3306/huashan
"""
import os

from sqlalchemy import create_engine

DEFAULT_DSN = "mysql+pymysql://root@127.0.0.1:3306/huashan?charset=utf8mb4"


def engine():
    """Return a SQLAlchemy engine for the analysis database."""
    return create_engine(os.environ.get("HUASHAN_DSN", DEFAULT_DSN), pool_pre_ping=True)
