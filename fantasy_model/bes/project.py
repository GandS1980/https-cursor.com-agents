"""Assemble point-in-time projection inputs for a target week.

Everything is computed from rows strictly before the target week plus pregame information
(schedule, Vegas lines, final injury report, depth chart as of kickoff).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import datasets as D
from .db import load_league, read_dataset
from .efficiency import EfficiencyFeatures, kicker_rates, league_rates, player_rates
from .workload import (WorkloadParams, history_before, normalize_team_shares, opponent_factors,
                       player_shares, team_volume)

SKILL = ["QB", "RB", "WR", "TE"]


@dataclass
class History:
    """Cached full-history frames (built once, sliced per target week)."""
    player_game: pd.DataFrame
    team_game: pd.DataFrame
    dst_game: pd.DataFrame
    pregame: pd.DataFrame
    rosters: pd.DataFrame
    injuries: pd.DataFrame
    depth: pd.DataFrame | None = None

    @classmethod
    def load(cls) -> "History":
        rosters = read_dataset("rosters")
        rosters = rosters[rosters["game_type"].fillna("REG") == "REG"]
        try:
            inj = read_dataset("injuries")
        except FileNotFoundError:
            inj = pd.DataFrame(columns=["season", "week", "gsis_id", "report_status"])
        try:
            depth = read_dataset("depth_charts")
        except FileNotFoundError:
            depth = None
        return cls(D.build_player_game(), D.build_team_game(), D.build_dst_game(), D.build_pregame(),
                   rosters, inj, depth)


@dataclass
class SlateInputs:
    season: int
    week: int
    players: pd.DataFrame          # one row per offensive player (incl. K)
    teams: pd.DataFrame            # one row per team playing this week
    league: dict
    workload_params: WorkloadParams
    features: EfficiencyFeatures
    meta: dict = field(default_factory=dict)


def _play_probability(status: pd.Series, cfg: dict) -> pd.Series:
    table = {str(k): float(v) for k, v in cfg["play_probability"].items()}
    s = status.fillna("None").astype(str)
    return s.map(lambda x: table.get(x, table.get("None", 0.99)))


def slate_players(h: History, season: int, week: int) -> pd.DataFrame:
    r = h.rosters[(h.rosters["season"] == season) & (h.rosters["week"] <= week)]
    if r.empty:
        raise ValueError(f"No roster data for {season} week {week}")
    r = r[r["week"] == r["week"].max()]
    # ACT/INA only. INA (gameday inactive) is treated as rostered: inactives are announced
    # ~90 minutes before kickoff, after most lineup decisions, so backtests must not use them.
    r = r[r["status"].isin(["ACT", "INA"]) & r["position"].isin(SKILL + ["K"])]
    r = r.rename(columns={"gsis_id": "player_id", "full_name": "player_name"})
    return r[["player_id", "player_name", "team", "position"]].dropna(subset=["player_id"]).drop_duplicates("player_id")


def build_inputs(h: History, season: int, week: int, wp: WorkloadParams | None = None,
                 feats: EfficiencyFeatures | None = None, cfg: dict | None = None) -> SlateInputs:
    cfg = cfg or load_league()
    wp = wp or WorkloadParams()
    feats = feats or EfficiencyFeatures()
    pre = h.pregame[(h.pregame["season"] == season) & (h.pregame["week"] == week)].copy()
    if pre.empty:
        raise ValueError(f"No games scheduled for {season} week {week}")
    teams_playing = pre["team"].tolist()

    ph = history_before(h.player_game, season, week)
    th = history_before(h.team_game, season, week)
    dh = history_before(h.dst_game, season, week)

    players = slate_players(h, season, week)
    players = players[players["team"].isin(teams_playing)]
    kickoff = dict(zip(pre["team"], pre["kickoff"]))
    try:
        depth = D.depth_for_week(season, week, kickoff, h.depth)
        players = players.merge(depth[["player_id", "depth_rank"]], on="player_id", how="left")
    except (FileNotFoundError, KeyError):
        players["depth_rank"] = np.nan

    inj = h.injuries[(h.injuries["season"] == season) & (h.injuries["week"] == week)]
    inj = inj.rename(columns={"gsis_id": "player_id"})[["player_id", "report_status"]].drop_duplicates("player_id", keep="last")
    players = players.merge(inj, on="player_id", how="left")
    players["p_play"] = _play_probability(players["report_status"], cfg)

    # Drop deep reserves with no recent role (keeps the slate tractable, avoids noise).
    recent_ids = set(ph[ph["season"] >= season - 1]["player_id"])
    keep = (players["depth_rank"].fillna(9) <= 3) | players["player_id"].isin(recent_ids)
    players = players[keep].reset_index(drop=True)

    shares = player_shares(ph, players[["player_id", "position", "depth_rank"]], wp)
    rates = player_rates(ph, players[["player_id", "position"]])
    players = players.merge(shares.drop(columns=["position", "depth_rank"]), on="player_id", how="left") \
                     .merge(rates.drop(columns=["position"]), on="player_id", how="left")
    # Shares among non-QBs for attempts are irrelevant; QBs don't get targets.
    players.loc[players["position"] != "QB", "att_share"] = 0.0
    players.loc[players["position"] == "QB", ["tgt_share", "rz_tgt_share"]] = 0.0
    players.loc[players["position"] == "K", ["tgt_share", "rz_tgt_share", "car_share", "rz_car_share",
                                             "gl_car_share", "att_share"]] = 0.0
    # Starting QB comes from the point-in-time depth chart: QB1 starts unless inactive, then QB2.
    # (History shares mislead: a backup's past starts elsewhere would make him a co-starter.)
    qb = players["position"] == "QB"
    for team, idx in players[qb].groupby("team").groups.items():
        ranks = players.loc[idx, "depth_rank"]
        if ranks.notna().any():
            players.loc[idx, "att_share"] = np.select([ranks == ranks.min(), ranks == ranks[ranks > ranks.min()].min()],
                                                      [1.0, 1e-3], 1e-6)
    # QB rushing share is measured only in games the QB started; relief appearances and
    # injury-shortened games would dilute a running QB's role.
    started = ph[(ph["position"] == "QB") & (ph["attempts"] >= 0.5 * ph["team_attempts"])]
    qrows = players.loc[qb, ["player_id", "position", "depth_rank"]]
    if len(qrows) and len(started):
        qs = player_shares(started, qrows, wp).set_index("player_id")["car_share"]
        players.loc[qb, "car_share"] = players.loc[qb, "player_id"].map(qs).fillna(players.loc[qb, "car_share"]).to_numpy()
    # Backup QBs only carry when they start (handled per simulated game), so they must not
    # crowd the starter or the RBs out of the team's carry budget during normalization.
    backup = qb & (players["att_share"] < 0.5)
    backup_car = players.loc[backup, "car_share"].copy()
    players.loc[backup, "car_share"] = 0.0
    players = normalize_team_shares(players)
    players.loc[backup_car.index, "car_share"] = backup_car

    league = league_rates(ph)
    kr = kicker_rates(ph, players[players["position"] == "K"][["player_id"]], league)
    players = players.merge(kr, on="player_id", how="left")
    players["fg_make_mult"] = players["fg_make_mult"].fillna(1.0)

    teams = team_volume(th, teams_playing, wp).merge(pre, on="team", how="left")
    # DEF event rates (blended team history, shrunk to league)
    dcols = ["dst_tds", "dst_return_tds", "dst_safeties", "dst_blocked_kicks", "dst_return_yards",
             "dst_extra_point_returns"]
    dl = dh.sort_values(["season", "week"]).groupby("team").tail(wp.long_games)
    # League baseline from the most recent ~season only: rule changes (e.g. the 2025 kickoff
    # rule raised return yardage) make older seasons a biased anchor.
    lg = dh.sort_values(["season", "week"]).tail(32 * 17)[dcols].mean()
    dm = dl.groupby("team")[dcols].mean()
    dn = dl.groupby("team").size()
    for c in dcols:
        n = dn.reindex(teams["team"]).fillna(0).to_numpy()
        lc = 0.0 if pd.isna(lg[c]) else lg[c]
        teams[c] = (n * dm[c].reindex(teams["team"]).fillna(lc).to_numpy() + 8 * lc) / (n + 8)

    if feats.opponent_adjustment:
        of = opponent_factors(th, wp)
        f = of.reindex(teams["opponent"]).fillna(1.0).to_numpy()
        teams["opp_pass_ypa_f"] = f[:, of.columns.get_loc("passing_yards")] / f[:, of.columns.get_loc("attempts")]
        teams["opp_rush_ypc_f"] = f[:, of.columns.get_loc("rushing_yards")] / f[:, of.columns.get_loc("carries")]
        teams["opp_td_f"] = (f[:, of.columns.get_loc("passing_tds")] + f[:, of.columns.get_loc("rushing_tds")]) / 2
    else:
        teams["opp_pass_ypa_f"] = teams["opp_rush_ypc_f"] = teams["opp_td_f"] = 1.0

    hist_pts = 6.95 * (teams["passing_tds"] + teams["rushing_tds"]) + 3 * 0.85 * teams["fg_att"]
    if feats.vegas_scoring:
        target = np.where(teams["implied_total"].notna(),
                          feats.vegas_weight * teams["implied_total"] + (1 - feats.vegas_weight) * hist_pts, hist_pts)
    else:
        target = hist_pts
    teams["score_scale"] = (target / hist_pts.replace(0, np.nan)).fillna(1.0).clip(0.5, 1.8)
    meta = {"data_cutoff": f"before {season} week {week}", "n_players": len(players)}
    return SlateInputs(season, week, players, teams, league, wp, feats, meta)


def calibrate_play_probability(h: History) -> pd.DataFrame:
    """Empirical P(plays | final report status) from history: injury report vs appearing in stats."""
    inj = h.injuries.rename(columns={"gsis_id": "player_id"})
    inj = inj[inj["position"].isin(SKILL + ["K"])][["season", "week", "player_id", "report_status"]].dropna()
    played = h.player_game[["season", "week", "player_id"]].drop_duplicates().assign(played=1)
    m = inj.merge(played, on=["season", "week", "player_id"], how="left").fillna({"played": 0})
    m = m[m["season"] < m["season"].max()] if m["season"].nunique() > 1 else m
    return m.groupby("report_status")["played"].agg(["mean", "size"]).rename(columns={"mean": "p_play", "size": "n"})
