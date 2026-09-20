"""Phase 1 sanity check: confirm the research bench can read the rebuilt analysis DB.

Run from this directory:  python sanity_check.py
"""
import pandas as pd

from db import engine


def main():
    eng = engine()

    run = pd.read_sql(
        "SELECT run_id, status, mode, source_game_count, valid_games, invalid_games, "
        "algorithm_version, knowledge_version "
        "FROM analysis_runs ORDER BY run_id DESC LIMIT 1",
        eng,
    )
    print("Latest analysis run:")
    print(run.to_string(index=False))

    cov = pd.read_sql(
        "SELECT COUNT(*) AS games, SUM(parsed_ok = 0) AS failed, "
        "SUM(doubt_count > 0) AS doubt FROM analysis_games",
        eng,
    )
    print("\nCoverage:")
    print(cov.to_string(index=False))

    periods = pd.read_sql(
        "SELECT period_type, camp, COUNT(*) AS period_rows "
        "FROM analysis_player_periods GROUP BY period_type, camp "
        "ORDER BY period_type, camp",
        eng,
    )
    print("\nPeriod rows by scope:")
    print(periods.to_string(index=False))


if __name__ == "__main__":
    main()
