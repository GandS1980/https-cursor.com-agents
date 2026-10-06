"""Production (efficiency) model: yards and touchdowns conditional on opportunities.

Kept separate from workload on purpose: a back can be inefficient but valuable through volume,
or efficient but unusable through limited touches. Every rate is shrunk toward the position mean
with a pseudo-count, because per-opportunity rates are noisy (yards per carry stabilizes slowly).

Optional features are switched on through `EfficiencyFeatures` and must earn their place on
later, unseen weeks (`bes.backtest.feature_ablation`).
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np
import pandas as pd

from .stats import FG_BUCKETS


@dataclass(frozen=True)
class EfficiencyFeatures:
    redzone_td_weighting: bool = True   # goal-line / red-zone role tilts TD allocation
    opponent_adjustment: bool = False   # opponent yards-allowed factors
    vegas_scoring: bool = True          # team TD/FG rates anchored to the implied team total
    vegas_weight: float = 0.6

    def as_dict(self) -> dict:
        return asdict(self)


PSEUDO = {"catch_rate": 40, "ypr": 25, "ypc": 80, "rec_td_w": 30, "rush_td_w": 40,
          "fumble_per_touch": 400, "int_rate": 300, "fg_make": 30, "two_pt": 34}


def _shrunk(num: pd.Series, den: pd.Series, prior: pd.Series | float, k: float) -> pd.Series:
    return (num.fillna(0) + k * prior) / (den.fillna(0) + k)


def player_rates(hist: pd.DataFrame, players: pd.DataFrame, long_games: int = 24) -> pd.DataFrame:
    h = hist.sort_values(["season", "week"]).groupby("player_id").tail(long_games)
    agg = h.groupby("player_id").agg(
        targets=("targets", "sum"), receptions=("receptions", "sum"), rec_yds=("receiving_yards", "sum"),
        rec_tds=("receiving_tds", "sum"), carries=("carries", "sum"), rush_yds=("rushing_yards", "sum"),
        rush_tds=("rushing_tds", "sum"), fum=("fumbles_lost", "sum"), two_pt=("two_pt_conversions", "sum"),
        games=("week", "size"), att=("attempts", "sum"), ints=("passing_interceptions", "sum"),
        tgt_share=("tgt_share", "mean"), rz_tgt=("rz_targets", "sum"), team_rz_tgt=("team_rz_targets", "sum"),
        team_tgt=("team_targets", "sum"), rz_car=("rz_carries", "sum"), team_rz_car=("team_rz_carries", "sum"),
        team_car=("team_carries", "sum"),
    )
    # recent return role
    last = hist.sort_values(["season", "week"]).groupby("player_id").tail(4)
    ret = last.groupby("player_id").agg(ret_yds=("return_yards", "mean"),
                                        ret_n=("punt_returns", "sum"), kr_n=("kickoff_returns", "sum"))

    out = players.set_index("player_id")[["position"]].copy()
    a = agg.reindex(out.index)
    pos = out["position"]
    h = h.assign(touches=h["carries"].fillna(0) + h["receptions"].fillna(0))
    by_pos = h.groupby("position").agg(rec=("receptions", "sum"), tgt=("targets", "sum"),
                                             ryd=("receiving_yards", "sum"), car=("carries", "sum"),
                                             cyd=("rushing_yards", "sum"), rtd=("receiving_tds", "sum"),
                                             tch=("touches", "sum"),
                                             ctd=("rushing_tds", "sum"), fum=("fumbles_lost", "sum"),
                                             g=("week", "size"), tp=("two_pt_conversions", "sum"))
    pm = lambda num, den, d: (by_pos[num] / by_pos[den].replace(0, np.nan)).reindex(pos).fillna(d).to_numpy()  # noqa: E731
    out["catch_rate"] = _shrunk(a["receptions"], a["targets"], pm("rec", "tgt", 0.65), PSEUDO["catch_rate"]).clip(0.2, 0.95)
    out["ypr"] = _shrunk(a["rec_yds"], a["receptions"], pm("ryd", "rec", 10.0), PSEUDO["ypr"]).clip(3, 25)
    out["ypc"] = _shrunk(a["rush_yds"], a["carries"], pm("cyd", "car", 4.2), PSEUDO["ypc"]).clip(1, 8)
    out["fumble_per_touch"] = _shrunk(a["fum"], a["carries"].fillna(0) + a["receptions"].fillna(0),
                                      pm("fum", "tch", 0.004), PSEUDO["fumble_per_touch"])
    out["two_pt_per_game"] = _shrunk(a["two_pt"], a["games"], pm("tp", "g", 0.02), PSEUDO["two_pt"])
    # TD weights relative to opportunity (1.0 = typical); red-zone role raises them.
    rz_tgt_ratio = (a["rz_tgt"] / a["team_rz_tgt"].replace(0, np.nan)) / (a["targets"] / a["team_tgt"].replace(0, np.nan))
    rz_car_ratio = (a["rz_car"] / a["team_rz_car"].replace(0, np.nan)) / (a["carries"] / a["team_car"].replace(0, np.nan))
    n_t, n_c = a["targets"].fillna(0), a["carries"].fillna(0)
    out["rec_td_w"] = ((n_t * rz_tgt_ratio.fillna(1) + PSEUDO["rec_td_w"]) / (n_t + PSEUDO["rec_td_w"])).clip(0.2, 3)
    out["rush_td_w"] = ((n_c * rz_car_ratio.fillna(1) + PSEUDO["rush_td_w"]) / (n_c + PSEUDO["rush_td_w"])).clip(0.2, 3)
    out["int_rate"] = _shrunk(a["ints"], a["att"], 0.023, PSEUDO["int_rate"])
    r = ret.reindex(out.index)
    out["returner"] = (r["ret_n"].fillna(0) + r["kr_n"].fillna(0)) >= 2
    out["ret_yds_mu"] = np.where(out["returner"], r["ret_yds"].fillna(0), 0.0)
    return out.reset_index()


def league_rates(player_hist: pd.DataFrame) -> dict:
    """League-level rates for the 'other' bucket, kicking and DEF events."""
    h = player_hist.sort_values(["season", "week"])
    recent = h[h["season"] >= h["season"].max() - 1]
    rec = recent[recent["position"].isin(["WR", "TE", "RB"])]
    k = recent[recent["position"] == "K"]
    out = {
        "other_catch_rate": rec["receptions"].sum() / max(rec["targets"].sum(), 1),
        "other_ypr": rec["receiving_yards"].sum() / max(rec["receptions"].sum(), 1),
        "other_ypc": recent["rushing_yards"].sum() / max(recent["carries"].sum(), 1),
        "pat_make": k["pat_made"].sum() / max(k["pat_att"].sum(), 1),
    }
    made = {b: k[f"fg_made_{b}"].sum() if f"fg_made_{b}" in k else 0 for b in FG_BUCKETS}
    miss = {b: k[f"fg_missed_{b}"].sum() if f"fg_missed_{b}" in k else 0 for b in FG_BUCKETS}
    att = {b: made[b] + miss[b] for b in FG_BUCKETS}
    tot = max(sum(att.values()), 1)
    out["fg_bucket_p"] = np.array([att[b] / tot for b in FG_BUCKETS])
    out["fg_make_p"] = np.array([(made[b] + 1) / (att[b] + 2) for b in FG_BUCKETS])
    return out


def kicker_rates(hist: pd.DataFrame, kickers: pd.DataFrame, league: dict) -> pd.DataFrame:
    """Kicker make-rate multiplier vs league expectation for his attempt mix (shrunk)."""
    h = hist[hist["position"] == "K"].sort_values(["season", "week"]).groupby("player_id").tail(32)
    rows = []
    for pid in kickers["player_id"]:
        g = h[h["player_id"] == pid]
        made = sum(g[f"fg_made_{b}"].sum() for b in FG_BUCKETS)
        exp = sum((g[f"fg_made_{b}"].sum() + g[f"fg_missed_{b}"].sum()) * league["fg_make_p"][i]
                  for i, b in enumerate(FG_BUCKETS))
        mult = (made + PSEUDO["fg_make"]) / (exp + PSEUDO["fg_make"]) if exp >= 0 else 1.0
        rows.append({"player_id": pid, "fg_make_mult": float(np.clip(mult, 0.85, 1.1))})
    return pd.DataFrame(rows)
