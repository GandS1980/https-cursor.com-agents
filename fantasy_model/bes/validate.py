"""Validate the Da B.E.S. scoring function against completed Yahoo player scores.

Input: data/inputs/yahoo_actual_scores.csv with columns
    season, week, yahoo_points, and either yahoo_id or (player_name [+ team]); position optional.
    Team defenses: position=DEF and team=<NFL abbreviation>.

Output: a row-level mismatch report with the per-rule breakdown, plus an inferred-correction
table. Because nearly all rules are linear, (yahoo - ours) is regressed on each stat; any
coefficient that is clearly nonzero is a scoring weight that is set wrong.
"""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

from .ingest import player_id_map
from .project import History
from .scoring import ScoringRules, score_frame

TOL = 0.011  # Yahoo displays two decimals


def _norm(name: str) -> str:
    name = re.sub(r"[^a-z ]", "", str(name).lower())
    return re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", name).strip()


def match_players(yahoo: pd.DataFrame, ids: pd.DataFrame) -> pd.DataFrame:
    y = yahoo.copy()
    y["player_id"] = pd.NA
    if "position" in y:
        is_def = y["position"].astype(str).str.upper().isin(["DEF", "DST", "D/ST"])
        y.loc[is_def, "player_id"] = "DEF_" + y.loc[is_def, "team"].astype(str).str.upper()
    if "yahoo_id" in y:
        m = dict(zip(ids["yahoo_id"].astype(str), ids["gsis_id"]))
        y["player_id"] = y["player_id"].fillna(y["yahoo_id"].astype(str).str.replace(r"\.0$", "", regex=True).map(m))
    if "player_name" in y:
        ids = ids.assign(_n=ids["full_name"].map(_norm))
        by_name = ids.drop_duplicates("_n", keep=False).set_index("_n")["gsis_id"]
        y["player_id"] = y["player_id"].fillna(y["player_name"].map(_norm).map(by_name))
    return y


def validate(yahoo_csv: str, rules: ScoringRules, h: History | None = None) -> dict[str, pd.DataFrame]:
    h = h or History.load()
    yahoo = pd.read_csv(yahoo_csv)
    y = match_players(yahoo, player_id_map())
    unmatched = y[y["player_id"].isna()]
    y = y.dropna(subset=["player_id"])

    stats = pd.concat([h.player_game, h.dst_game], ignore_index=True)
    ours = score_frame(stats, rules, with_breakdown=True)
    m = y.merge(ours, on=["player_id", "season", "week"], how="left", suffixes=("_yahoo", ""))
    no_stats = m[m["bes_points"].isna()]
    # A player Yahoo scored 0 who has no nflverse row did not play: that is a match.
    m.loc[m["bes_points"].isna() & (m["yahoo_points"].abs() < TOL), "bes_points"] = 0.0
    m["diff"] = m["bes_points"] - m["yahoo_points"]
    mism = m[(m["diff"].abs() > TOL) | m["diff"].isna()]

    # Infer weight corrections: (yahoo - ours) ~ sum_s delta_s * stat_s
    linear = [s for s in rules.linear_terms() if s in m.columns] + \
             [s for s in ["completions", "carries", "targets", "receptions", "return_yards", "attempts",
                          "sacks_suffered", "two_pt_conversions", "fumbles_lost", "pat_missed"]
              if s in m.columns and s not in rules.linear_terms()]
    linear = list(dict.fromkeys(linear))
    corr = pd.DataFrame()
    fit = m.dropna(subset=["diff"])
    if len(fit) >= 20:
        X = fit[linear].fillna(0).to_numpy(float)
        keep = X.std(axis=0) > 0
        X = X[:, keep]
        target = -fit["diff"].to_numpy(float)  # yahoo - ours
        coef, *_ = np.linalg.lstsq(X, target, rcond=None)
        resid = target - X @ coef
        names = [s for s, k in zip(linear, keep) if k]
        corr = pd.DataFrame({"stat": names, "current_weight": [rules.linear_terms().get(s, 0.0) for s in names],
                             "inferred_delta": coef})
        corr["suggested_weight"] = corr["current_weight"] + corr["inferred_delta"]
        corr = corr[corr["inferred_delta"].abs() > 0.02].sort_values("inferred_delta", key=np.abs, ascending=False)
        corr.attrs["residual_mae_after_fix"] = float(np.abs(resid).mean())

    by_pos = m.groupby(m["position"] if "position" in m else "position_yahoo").agg(
        n=("diff", "size"), mismatches=("diff", lambda d: int((d.abs() > TOL).sum())),
        mean_diff=("diff", "mean")).reset_index() if len(m) else pd.DataFrame()
    return {"mismatches": mism, "unmatched": unmatched, "no_stats": no_stats,
            "inferred_corrections": corr, "by_position": by_pos, "all": m}


def yahoo_projection_baseline(proj_csv: str, rules: ScoringRules) -> pd.DataFrame:
    """Score Yahoo projected stat lines under Da B.E.S. rules (baseline for backtests).

    CSV: season, week, yahoo_id|player_name, position, team, and projected stats using canonical
    names (passing_yards, receptions, ...). FG distance columns: fg_made_<bucket> with buckets
    0_19, 20_29, 30_39, 40_49, 50_plus. A stat a projection omits is treated as projected 0.
    """
    p = pd.read_csv(proj_csv)
    p = match_players(p, player_id_map()).dropna(subset=["player_id"])
    if "position" not in p:
        raise ValueError("yahoo projections need a position column")
    p["position"] = p["position"].str.upper().replace({"DST": "DEF"})
    for stat in rules.linear_terms():
        p[stat] = p[stat].fillna(0.0) if stat in p else 0.0
    for b in rules.bonuses:
        for stat in b.stats:
            p[stat] = p[stat].fillna(0.0) if stat in p else 0.0
    scored = score_frame(p, rules)
    return scored[["season", "week", "player_id", "bes_points"]].rename(columns={"bes_points": "yahoo"})
