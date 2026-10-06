"""The three core datasets.

1. player_game   — one row per player per team-game they appeared in (stats, snaps, red zone).
2. pregame       — one row per team-game: opponent, venue, kickoff, roof, Vegas lines, weather
                   (with its provenance), plus per-player injury/depth context via `player_context`.
3. projection_history lives in DuckDB (see db.py) and is written by `bes.project`.

Conventions: `player_id` is the nflverse GSIS id (team DEF uses `DEF_<team>`). A player who did not
play has NO row (missing), which is different from a row of zeros (played, recorded nothing).
Routes run are not available from any current source -> `routes` and `yprr` are NaN columns.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import db
from .stats import add_derived_stats, dst_stats_from_team_week

OFFENSE_POS = {"QB", "RB", "WR", "TE", "FB", "K"}


def _ids() -> pd.DataFrame:
    r = db.read_dataset("rosters")
    return r[["gsis_id", "pfr_id"]].dropna().drop_duplicates("pfr_id")


def build_player_game(season_type: str = "REG") -> pd.DataFrame:
    pw = db.read_dataset("player_week")
    pw = pw[pw["season_type"] == season_type]
    pw = pw[pw["position"].isin(OFFENSE_POS)].copy()
    pw.loc[pw["position"] == "FB", "position"] = "RB"
    pw = add_derived_stats(pw)

    # Snaps: map PFR id -> GSIS id. Snap rows without a stats row = played but recorded no stats.
    try:
        sn = db.read_dataset("snaps")
        sn = sn[sn["game_type"] == season_type].merge(_ids(), left_on="pfr_player_id", right_on="pfr_id", how="inner")
        sn = sn.rename(columns={"gsis_id": "player_id"})[
            ["player_id", "season", "week", "team", "offense_snaps", "offense_pct", "st_snaps", "position"]]
        sn = sn[sn["position"].isin(OFFENSE_POS)]
        sn.loc[sn["position"] == "FB", "position"] = "RB"
        pw = pw.merge(sn.drop(columns="position"), on=["player_id", "season", "week", "team"], how="left")
        snap_only = sn.merge(pw[["player_id", "season", "week"]], how="left", indicator=True,
                             on=["player_id", "season", "week"])
        snap_only = snap_only[(snap_only["_merge"] == "left_only") & (snap_only["offense_snaps"] > 0)]
        if len(snap_only):
            filler = snap_only.drop(columns="_merge").copy()
            stat_cols = [c for c in pw.columns if pd.api.types.is_numeric_dtype(pw[c])
                         and c not in filler.columns and c not in ("season", "week")]
            # genuinely zero: was on the field, recorded nothing
            filler = pd.concat([filler, pd.DataFrame(0.0, index=filler.index, columns=stat_cols)], axis=1)
            pw = pd.concat([pw, filler], ignore_index=True)
    except FileNotFoundError:
        pw["offense_snaps"] = np.nan
        pw["offense_pct"] = np.nan

    try:
        rz = db.read_dataset("redzone").drop(columns=["game_id"], errors="ignore")
        pw = pw.merge(rz, on=["season", "week", "team", "player_id"], how="left")
        for c in ("rz_carries", "gl_carries", "rz_targets", "gl_targets", "ez_targets"):
            # pbp exists for this game -> no red-zone rows means zero, not unknown
            pw[c] = pw[c].fillna(0.0)
    except FileNotFoundError:
        for c in ("rz_carries", "gl_carries", "rz_targets", "gl_targets", "ez_targets"):
            pw[c] = np.nan

    pw = pw.copy()
    pw["routes"] = np.nan  # no verified charting feed yet
    pw["yprr"] = np.nan

    # Team totals (sum over players) for shares.
    tkeys = ["season", "week", "team"]
    tot = pw.groupby(tkeys)[["targets", "carries", "attempts", "rz_carries", "rz_targets", "gl_carries"]] \
        .sum(min_count=1).add_prefix("team_").reset_index()
    pw = pw.merge(tot, on=tkeys, how="left")
    pw["tgt_share"] = pw["targets"] / pw["team_targets"]
    pw["car_share"] = pw["carries"] / pw["team_carries"]
    pw["played"] = True
    if "player_display_name" in pw:
        pw["player_name"] = pw["player_display_name"].fillna(pw.get("player_name"))
    return pw.sort_values(["season", "week", "team", "player_id"]).reset_index(drop=True)


def build_dst_game(season_type: str = "REG") -> pd.DataFrame:
    tw = db.read_dataset("team_week")
    tw = tw[tw["season_type"] == season_type]
    games = db.read_dataset("games")
    d = dst_stats_from_team_week(tw, games)
    d["player_name"] = d["team"] + " DEF"
    d["played"] = True
    return d


def build_team_game(season_type: str = "REG") -> pd.DataFrame:
    """Team offensive volume per game (used for team-volume baselines and opponent adjustments)."""
    tw = db.read_dataset("team_week")
    tw = tw[tw["season_type"] == season_type]
    cols = ["season", "week", "game_id", "team", "opponent_team", "attempts", "completions", "carries",
            "passing_yards", "rushing_yards", "passing_tds", "rushing_tds", "passing_interceptions",
            "sacks_suffered", "fg_att", "fg_made", "pat_att", "pat_made", "rushing_fumbles_lost",
            "receiving_fumbles_lost", "sack_fumbles_lost", "passing_epa", "rushing_epa"]
    t = tw[[c for c in cols if c in tw.columns]].copy()
    t["fumbles_lost"] = t[["rushing_fumbles_lost", "receiving_fumbles_lost", "sack_fumbles_lost"]].sum(axis=1)
    t["dropbacks"] = t["attempts"] + t["sacks_suffered"]
    return t


def build_pregame(season_type: str = "REG") -> pd.DataFrame:
    """One row per team-game with information knowable before kickoff."""
    g = db.read_dataset("games")
    g = g[g["game_type"] == season_type].copy()
    g["kickoff"] = pd.to_datetime(g["gameday"] + " " + g["gametime"].fillna("13:00"), errors="coerce")
    rows = []
    for side, opp in (("home", "away"), ("away", "home")):
        x = pd.DataFrame({
            "game_id": g["game_id"], "season": g["season"], "week": g["week"],
            "team": g[f"{side}_team"], "opponent": g[f"{opp}_team"], "is_home": side == "home",
            "kickoff": g["kickoff"], "stadium": g["stadium"], "roof": g["roof"], "surface": g["surface"],
            "rest_days": g[f"{side}_rest"], "spread_line": g["spread_line"], "total_line": g["total_line"],
            "div_game": g["div_game"],
            # nflverse temp/wind are OBSERVED at game time -> not a pregame forecast.
            "temp_observed": g["temp"], "wind_observed": g["wind"],
            "points_for": g[f"{side}_score"], "points_against": g[f"{opp}_score"],
        })
        # spread_line is home-team margin (positive = home favored)
        margin = np.where(side == "home", g["spread_line"], -g["spread_line"])
        x["implied_total"] = (g["total_line"] + margin) / 2.0
        x["implied_opp_total"] = (g["total_line"] - margin) / 2.0
        rows.append(x)
    pre = pd.concat(rows, ignore_index=True)
    pre["indoor"] = pre["roof"].isin(["dome", "closed"])
    pre["weather_source"] = np.where(pre["indoor"], "indoor", "observed_postgame_not_for_backtest")
    return pre.sort_values(["season", "week", "team"]).reset_index(drop=True)


def injuries_for_week(season: int, week: int) -> pd.DataFrame:
    """Final injury report designations for a week (published before kickoff)."""
    inj = db.read_dataset("injuries")
    inj = inj[(inj["season"] == season) & (inj["week"] == week)]
    cols = ["gsis_id", "team", "position", "full_name", "report_status", "practice_status",
            "report_primary_injury"]
    out = inj[[c for c in cols if c in inj.columns]].rename(columns={"gsis_id": "player_id"})
    if "fetched_at" in inj:
        out = out.assign(fetched_at=inj["fetched_at"])
    return out.drop_duplicates("player_id", keep="last")


def depth_for_week(season: int, week: int, kickoff_by_team: dict[str, pd.Timestamp] | None = None,
                   dc: pd.DataFrame | None = None) -> pd.DataFrame:
    """Depth-chart rank per player as of the week. Handles the old weekly and new timestamped schemas."""
    dc = db.read_dataset("depth_charts") if dc is None else dc
    dc = dc[dc["season"] == season].dropna(axis=1, how="all")
    if "dt" in dc.columns and dc["dt"].notna().any():
        dc = dc.copy()
        dc["dt"] = pd.to_datetime(dc["dt"], utc=True).dt.tz_localize(None)
        if kickoff_by_team:
            dc["cutoff"] = dc["team"].map(kickoff_by_team)
            dc = dc[dc["dt"] <= dc["cutoff"]]
        latest = dc.groupby("team")["dt"].transform("max")
        dc = dc[dc["dt"] == latest]
        out = dc.rename(columns={"gsis_id": "player_id", "pos_abb": "depth_pos", "pos_rank": "depth_rank"})
    else:
        dc = dc[(dc["week"] == week)]
        if "formation" in dc:
            dc = dc[dc["formation"].isin(["Offense", "Special Teams"])]
        out = dc.rename(columns={"gsis_id": "player_id", "club_code": "team", "depth_position": "depth_pos",
                                 "depth_team": "depth_rank"})
    out = out[["player_id", "team", "depth_pos", "depth_rank"]].dropna(subset=["player_id"])
    out["depth_rank"] = pd.to_numeric(out["depth_rank"], errors="coerce")
    return out.sort_values("depth_rank").drop_duplicates("player_id")
