"""Canonical stat names and derivation from nflverse columns.

Every stat the scoring function reads is defined here. Derived stats propagate missing values:
if any source column is absent or NaN, the derived stat is NaN (unknown), never 0.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

FG_BUCKETS = ["0_19", "20_29", "30_39", "40_49", "50_plus"]

# canonical stat -> list of nflverse source columns that are summed
DERIVED_SUMS: dict[str, list[str]] = {
    "fumbles_lost": ["rushing_fumbles_lost", "receiving_fumbles_lost", "sack_fumbles_lost"],
    "two_pt_conversions": ["passing_2pt_conversions", "rushing_2pt_conversions", "receiving_2pt_conversions"],
    "return_yards": ["punt_return_yards", "kickoff_return_yards"],
    "return_tds": ["special_teams_tds"],
    "offensive_fumble_return_tds": ["fumble_recovery_tds"],
    "fg_made_50_plus": ["fg_made_50_59", "fg_made_60_"],
    "fg_missed_50_plus": ["fg_missed_50_59", "fg_missed_60_"],
}

DERIVED_DIFFS: dict[str, tuple[str, str]] = {
    "incompletions": ("attempts", "completions"),
}

OFFENSE_COLUMNS = [
    "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions",
    "sacks_suffered", "passing_air_yards", "passing_epa", "carries", "rushing_yards", "rushing_tds",
    "rushing_epa", "receptions", "targets", "receiving_yards", "receiving_tds",
    "receiving_air_yards", "receiving_epa", "target_share", "air_yards_share", "wopr",
    "fg_att", "fg_made", "pat_att", "pat_made", "pat_missed",
] + [f"fg_made_{b}" for b in FG_BUCKETS[:-1]] + [f"fg_missed_{b}" for b in FG_BUCKETS[:-1]]


def _sum_strict(df: pd.DataFrame, cols: list[str]) -> pd.Series:
    if not all(c in df.columns for c in cols):
        return pd.Series(np.nan, index=df.index)
    return df[cols].sum(axis=1, min_count=len(cols))


def add_derived_stats(df: pd.DataFrame) -> pd.DataFrame:
    """Return a copy of an nflverse player/team-week frame with canonical derived stats added."""
    out = df.copy()
    for name, cols in DERIVED_SUMS.items():
        out[name] = _sum_strict(out, cols)
    for name, (a, b) in DERIVED_DIFFS.items():
        out[name] = out[a] - out[b] if a in out and b in out else np.nan
    return out


def dst_stats_from_team_week(team_week: pd.DataFrame, games: pd.DataFrame) -> pd.DataFrame:
    """Build team-DEF canonical stats (one row per team-game) from nflverse team stats + schedules.

    `team_week` columns used: def_sacks, def_interceptions, fumble_recovery_opp, def_tds,
    special_teams_tds, def_safeties, def_fg_blocks, def_punt_blocks, def_pat_blocks,
    kickoff_return_yards, punt_return_yards. Opponent points come from the schedule.
    """
    tw = team_week.copy()
    g = games[["game_id", "home_team", "away_team", "home_score", "away_score"]]
    tw = tw.merge(g, on="game_id", how="left")
    is_home = tw["team"] == tw["home_team"]
    tw["dst_points_allowed_all"] = np.where(is_home, tw["away_score"], tw["home_score"])
    # opponent DEF/ST touchdowns (needed for exclude_dst_scores mode)
    opp = tw[["game_id", "team", "def_tds", "special_teams_tds"]].rename(
        columns={"team": "opponent_team", "def_tds": "opp_def_tds", "special_teams_tds": "opp_st_tds"})
    tw = tw.merge(opp, on=["game_id", "opponent_team"], how="left")
    out = pd.DataFrame({
        "season": tw["season"], "week": tw["week"], "game_id": tw["game_id"],
        "team": tw["team"], "opponent_team": tw["opponent_team"],
        "player_id": "DEF_" + tw["team"], "position": "DEF",
        "dst_sacks": tw["def_sacks"],
        "dst_interceptions": tw["def_interceptions"],
        "dst_fumble_recoveries": tw["fumble_recovery_opp"],
        "dst_tds": tw["def_tds"],
        "dst_return_tds": tw["special_teams_tds"],
        "dst_safeties": tw["def_safeties"],
        "dst_blocked_kicks": tw[["def_fg_blocks", "def_punt_blocks", "def_pat_blocks"]].sum(axis=1, min_count=3),
        "dst_return_yards": tw[["kickoff_return_yards", "punt_return_yards"]].sum(axis=1, min_count=2),
        "dst_points_allowed_all": tw["dst_points_allowed_all"],
        "dst_points_allowed_excl": tw["dst_points_allowed_all"]
        - 6 * (tw["opp_def_tds"].fillna(0) + tw["opp_st_tds"].fillna(0)),
        # Not derivable from team stats: keep unknown, never zero.
        "dst_extra_point_returns": np.nan,
        "dst_4th_down_stops": np.nan,
    })
    return out
