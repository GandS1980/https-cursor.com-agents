"""Storage: Parquet files are the system of record; DuckDB holds views over them plus the
append-only tables (projection history, ingest log, snapshots)."""
from __future__ import annotations

from pathlib import Path

import duckdb
import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parents[1]


def load_league(path: str | Path = ROOT / "config/league.yaml") -> dict:
    return yaml.safe_load(Path(path).read_text())


def parquet_dir(cfg: dict | None = None) -> Path:
    cfg = cfg or load_league()
    p = ROOT / cfg["storage"]["parquet_dir"]
    p.mkdir(parents=True, exist_ok=True)
    return p


SCHEMA = """
CREATE TABLE IF NOT EXISTS ingest_log (
    dataset VARCHAR, season INTEGER, url VARCHAR, rows BIGINT, fetched_at TIMESTAMP);

-- Every projection the model publishes, with the information cutoff and the inputs it used.
CREATE TABLE IF NOT EXISTS projection_history (
    run_id VARCHAR, model_version VARCHAR, created_at TIMESTAMP, data_cutoff TIMESTAMP,
    season INTEGER, week INTEGER, player_id VARCHAR, player_name VARCHAR, position VARCHAR,
    team VARCHAR, scenario VARCHAR, p_play DOUBLE,
    exp_points DOUBLE, p10 DOUBLE, p25 DOUBLE, p50 DOUBLE, p75 DOUBLE, p90 DOUBLE,
    inputs_json VARCHAR,
    actual_points DOUBLE, resolved_at TIMESTAMP);

-- Outside projections / injury news captured via Firecrawl, stored with publication time.
CREATE TABLE IF NOT EXISTS external_snapshots (
    source VARCHAR, url VARCHAR, fetched_at TIMESTAMP, published_at TIMESTAMP,
    season INTEGER, week INTEGER, content_markdown VARCHAR);

CREATE TABLE IF NOT EXISTS external_projections (
    source VARCHAR, fetched_at TIMESTAMP, season INTEGER, week INTEGER,
    player_name VARCHAR, team VARCHAR, position VARCHAR, player_id VARCHAR,
    stat VARCHAR, value DOUBLE);
"""


def connect(cfg: dict | None = None, read_only: bool = False) -> duckdb.DuckDBPyConnection:
    cfg = cfg or load_league()
    path = ROOT / cfg["storage"]["duckdb"]
    path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(path), read_only=read_only)
    if not read_only:
        con.execute(SCHEMA)
        register_views(con, cfg)
    return con


def register_views(con: duckdb.DuckDBPyConnection, cfg: dict | None = None) -> None:
    base = parquet_dir(cfg)
    for d in sorted(p for p in base.iterdir() if p.is_dir()):
        if any(d.glob("*.parquet")):
            con.execute(f"CREATE OR REPLACE VIEW {d.name} AS "
                        f"SELECT * FROM read_parquet('{d.as_posix()}/*.parquet', union_by_name=true)")


def write_parquet(df: pd.DataFrame, dataset: str, name: str, cfg: dict | None = None) -> Path:
    d = parquet_dir(cfg) / dataset
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{name}.parquet"
    df.to_parquet(path, index=False)
    return path


def read_dataset(dataset: str, cfg: dict | None = None) -> pd.DataFrame:
    d = parquet_dir(cfg) / dataset
    files = sorted(d.glob("*.parquet"))
    if not files:
        raise FileNotFoundError(f"No parquet files for dataset '{dataset}'. Run `python -m bes.cli ingest`.")
    return pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
