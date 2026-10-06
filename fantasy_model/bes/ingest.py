"""nflverse ingestion -> Parquet + DuckDB.

Historical files are overwritten per season (they are revised by nflverse). Live-season injury
reports are additionally appended as timestamped snapshots so backtests of the current season
see only what was published before each decision.
"""
from __future__ import annotations

import datetime as dt
import io
import time

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import requests

from . import db

BASE = "https://github.com/nflverse/nflverse-data/releases/download"

SEASONAL = {
    "player_week": "stats_player/stats_player_week_{s}.parquet",
    "team_week": "stats_team/stats_team_week_{s}.parquet",
    "snaps": "snap_counts/snap_counts_{s}.parquet",
    "injuries": "injuries/injuries_{s}.parquet",
    "depth_charts": "depth_charts/depth_charts_{s}.parquet",
    "rosters": "weekly_rosters/roster_weekly_{s}.parquet",
}
PBP = "pbp/play_by_play_{s}.parquet"
GAMES = "schedules/games.parquet"

PBP_COLS = ["game_id", "season", "week", "posteam", "season_type", "yardline_100", "rush_attempt",
            "pass_attempt", "sack", "two_point_attempt", "rusher_player_id", "receiver_player_id",
            "passer_player_id", "air_yards", "qb_scramble"]


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


def fetch_parquet(path: str, columns: list[str] | None = None, retries: int = 4) -> pd.DataFrame:
    url = f"{BASE}/{path}"
    for attempt in range(retries):
        try:
            r = requests.get(url, timeout=120)
            if r.status_code == 404:
                raise FileNotFoundError(url)
            r.raise_for_status()
            table = pq.read_table(io.BytesIO(r.content), columns=columns)
            return table.to_pandas()
        except (requests.ConnectionError, requests.Timeout):
            if attempt == retries - 1:
                raise
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError("unreachable")


def redzone_from_pbp(pbp: pd.DataFrame) -> pd.DataFrame:
    """Per player-game red-zone and goal-line opportunities (offensive plays, no 2-pt tries)."""
    p = pbp[(pbp["two_point_attempt"].fillna(0) == 0)].copy()
    rz = p["yardline_100"] <= 20
    gl = p["yardline_100"] <= 5
    rush = (p["rush_attempt"] == 1) & p["rusher_player_id"].notna()
    tgt = (p["pass_attempt"] == 1) & (p["sack"].fillna(0) == 0) & p["receiver_player_id"].notna()
    ez = tgt & (p["air_yards"] >= p["yardline_100"])
    keys = ["season", "week", "game_id", "posteam"]
    rows = []
    for flag, pid_col, name in [(rush & rz, "rusher_player_id", "rz_carries"),
                                (rush & gl, "rusher_player_id", "gl_carries"),
                                (tgt & rz, "receiver_player_id", "rz_targets"),
                                (tgt & gl, "receiver_player_id", "gl_targets"),
                                (ez, "receiver_player_id", "ez_targets")]:
        g = p[flag].groupby(keys + [pid_col]).size().rename(name).reset_index()
        rows.append(g.rename(columns={pid_col: "player_id"}).set_index(keys + ["player_id"]))
    out = pd.concat(rows, axis=1).fillna(0).reset_index().rename(columns={"posteam": "team"})
    team = p[rz & (rush | tgt)].groupby(keys).size().rename("team_rz_plays").reset_index() \
        .rename(columns={"posteam": "team"})
    return out.merge(team, on=["season", "week", "game_id", "team"], how="left")


def ingest(seasons: list[int], include_pbp: bool = True, log=print) -> None:
    cfg = db.load_league()
    con = db.connect(cfg)
    fetched = _now()

    games = fetch_parquet(GAMES)
    db.write_parquet(games, "games", "all", cfg)
    con.execute("INSERT INTO ingest_log VALUES (?, ?, ?, ?, ?)", ["games", None, GAMES, len(games), fetched])
    log(f"games: {len(games)} rows")

    for s in seasons:
        for name, tmpl in SEASONAL.items():
            path = tmpl.format(s=s)
            try:
                df = fetch_parquet(path)
            except FileNotFoundError:
                log(f"{name} {s}: not published")
                continue
            df["fetched_at"] = fetched
            if "season" not in df.columns:  # 2025+ depth charts are timestamped and lack season
                df["season"] = s
            db.write_parquet(df, name, str(s), cfg)
            if name == "injuries":  # append-only snapshot for point-in-time backtests
                db.write_parquet(df, "injury_snapshots", f"{s}_{fetched:%Y%m%dT%H%M%S}", cfg)
            con.execute("INSERT INTO ingest_log VALUES (?, ?, ?, ?, ?)", [name, s, path, len(df), fetched])
            log(f"{name} {s}: {len(df)} rows")
        if include_pbp:
            try:
                pbp = fetch_parquet(PBP.format(s=s), columns=PBP_COLS)
                rz = redzone_from_pbp(pbp)
                db.write_parquet(rz, "redzone", str(s), cfg)
                log(f"redzone {s}: {len(rz)} rows (from {len(pbp)} plays)")
            except FileNotFoundError:
                log(f"pbp {s}: not published")
    db.register_views(con, cfg)
    con.close()


def player_id_map() -> pd.DataFrame:
    """Stable ID crosswalk: gsis_id (primary) <-> yahoo_id, pfr_id, sleeper_id, espn_id, name."""
    r = db.read_dataset("rosters")
    cols = ["gsis_id", "yahoo_id", "pfr_id", "sleeper_id", "espn_id", "full_name", "position", "team", "season", "week"]
    r = r[[c for c in cols if c in r.columns]].dropna(subset=["gsis_id"])
    r = r.sort_values(["season", "week"]).groupby("gsis_id").last().reset_index()
    for c in ("yahoo_id", "espn_id", "sleeper_id"):
        if c in r:
            r[c] = r[c].astype("string").str.replace(r"\.0$", "", regex=True)
    return r.drop(columns=["season", "week"])


if __name__ == "__main__":  # pragma: no cover
    ingest(db.load_league()["history_seasons"])
