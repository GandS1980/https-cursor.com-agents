"""Chronological backtesting: every historical week is predicted using only earlier information.

Metrics
  * point error (MAE / RMSE / bias) on fantasy-relevant players
  * uncertainty calibration: share of outcomes inside the 10–90 (target 80%) and 25–75 (target 50%) bands
  * lineup regret: hindsight-optimal points minus points of the lineup the model chose, on a fixed
    set of synthetic rosters (identical rosters for every model compared) and on your real roster

Baselines
  * last3: average Da B.E.S. points over the player's last 3 games played
  * yahoo: Yahoo projected stat lines scored under Da B.E.S. rules (data/inputs/yahoo_projections.csv)
  * external: outside projections captured via Firecrawl (external_projections table)

Fantasy evaluation treats "did not play" as 0 points (that is what a started inactive player
scores); this is separate from modeling, where a missed game is missing, not a zero workload.
"""
from __future__ import annotations

import itertools
from dataclasses import replace

import numpy as np
import pandas as pd

from .efficiency import EfficiencyFeatures
from .optimizer import optimize_lineup, slot_config
from .project import History, build_inputs
from .scoring import ScoringRules, score_frame
from .simulate import SimConfig, simulate_slate
from .workload import WorkloadParams, history_before, player_shares, SHARE_STATS

RELEVANT = {"QB": 24, "RB": 48, "WR": 60, "TE": 20, "K": 16, "DEF": 16}
ROSTER_SHAPE = {"QB": 2, "RB": 5, "WR": 5, "TE": 2, "K": 1, "DEF": 1}


def actual_points(h: History, rules: ScoringRules, season: int, week: int) -> pd.DataFrame:
    pg = h.player_game[(h.player_game["season"] == season) & (h.player_game["week"] == week)]
    dg = h.dst_game[(h.dst_game["season"] == season) & (h.dst_game["week"] == week)]
    a = score_frame(pd.concat([pg, dg], ignore_index=True), rules)
    return a[["player_id", "bes_points"]].rename(columns={"bes_points": "actual"})


def last3_baseline(h: History, rules: ScoringRules, season: int, week: int) -> pd.DataFrame:
    ph = history_before(h.player_game, season, week)
    dh = history_before(h.dst_game, season, week)
    allh = score_frame(pd.concat([ph, dh], ignore_index=True), rules)
    allh = allh.sort_values(["season", "week"]).groupby("player_id").tail(3)
    return allh.groupby("player_id")["bes_points"].mean().rename("last3").reset_index()


def relevant_mask(df: pd.DataFrame, col: str = "exp_points") -> pd.Series:
    rank = df.groupby("position")[col].rank(ascending=False, method="first")
    return rank <= df["position"].map(RELEVANT).fillna(0)


def synthetic_rosters(pred: pd.DataFrame, n: int, seed: int) -> list[pd.DataFrame]:
    """Random but realistic rosters drawn from the relevant pool (same rosters for every model)."""
    rng = np.random.default_rng(seed)
    pool = pred[relevant_mask(pred)]
    out = []
    for _ in range(n):
        parts = []
        for pos, k in ROSTER_SHAPE.items():
            cand = pool[pool["position"] == pos]
            if len(cand) >= k:
                parts.append(cand.iloc[rng.choice(len(cand), k, replace=False)])
        out.append(pd.concat(parts)[["player_id", "position"]])
    return out


def lineup_regret(roster: pd.DataFrame, pred: pd.DataFrame, value_col: str, slots) -> float:
    r = roster.merge(pred[["player_id", value_col, "actual"]], on="player_id", how="left")
    r[value_col] = r[value_col].fillna(0)
    r["actual"] = r["actual"].fillna(0)
    chosen = optimize_lineup(r, value_col, slots)
    best = optimize_lineup(r, "actual", slots)
    got = r.set_index("player_id").loc[chosen.player_ids(), "actual"].sum()
    return float(best.expected - got)


def predict_week(h: History, rules: ScoringRules, season: int, week: int, wp: WorkloadParams,
                 feats: EfficiencyFeatures, n_sims: int, sim_cfg: SimConfig | None = None) -> pd.DataFrame:
    inp = build_inputs(h, season, week, wp, feats)
    res = simulate_slate(inp, rules, n_sims=n_sims, seed=season * 100 + week, cfg=sim_cfg, keep_points=False)
    s = res.summary
    s = s.merge(actual_points(h, rules, season, week), on="player_id", how="left")
    s["actual"] = s["actual"].fillna(0.0)
    s = s.merge(last3_baseline(h, rules, season, week), on="player_id", how="left")
    s["season"], s["week"] = season, week
    return s


def run_backtest(h: History, rules: ScoringRules, weeks: list[tuple[int, int]],
                 wp: WorkloadParams | None = None, feats: EfficiencyFeatures | None = None,
                 n_sims: int = 2000, n_rosters: int = 200, my_roster: pd.DataFrame | None = None,
                 extra_baselines: pd.DataFrame | None = None, sim_cfg: SimConfig | None = None,
                 log=print) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Returns (per-player predictions, weekly metrics)."""
    wp = wp or WorkloadParams()
    feats = feats or EfficiencyFeatures()
    slots = slot_config()
    preds, metrics = [], []
    for season, week in weeks:
        p = predict_week(h, rules, season, week, wp, feats, n_sims, sim_cfg)
        p["last3"] = p["last3"].fillna(p.groupby("position")["last3"].transform("median")).fillna(0)
        if extra_baselines is not None:
            eb = extra_baselines[(extra_baselines["season"] == season) & (extra_baselines["week"] == week)]
            p = p.merge(eb.drop(columns=["season", "week"]), on="player_id", how="left")
        preds.append(p)
        rel = p[relevant_mask(p)]
        m = {"season": season, "week": week, "n": len(rel)}
        cols = ["exp_points", "last3"] + ([c for c in extra_baselines.columns if c not in ("season", "week", "player_id")]
                                           if extra_baselines is not None else [])
        for c in cols:
            ok = rel[c].notna()
            e = rel.loc[ok, c] - rel.loc[ok, "actual"]
            m[f"mae_{c}"], m[f"rmse_{c}"], m[f"bias_{c}"] = e.abs().mean(), np.sqrt((e ** 2).mean()), e.mean()
        m["cov80"] = ((rel["actual"] >= rel["p10"]) & (rel["actual"] <= rel["p90"])).mean()
        m["cov50"] = ((rel["actual"] >= rel["p25"]) & (rel["actual"] <= rel["p75"])).mean()
        rosters = synthetic_rosters(p, n_rosters, seed=season * 100 + week)
        for c in cols:
            pc = p.copy()
            pc[c] = pc[c].fillna(pc["exp_points"]) if c != "exp_points" else pc[c]
            m[f"regret_{c}"] = float(np.mean([lineup_regret(r, pc, c, slots) for r in rosters]))
        if my_roster is not None:
            m["my_regret_model"] = lineup_regret(my_roster[["player_id", "position"]], p, "exp_points", slots)
        metrics.append(m)
        log(f"{season} wk{week:>2}: MAE model {m['mae_exp_points']:.2f} vs last3 {m['mae_last3']:.2f} | "
            f"cov80 {m['cov80']:.2f} cov50 {m['cov50']:.2f} | regret model {m['regret_exp_points']:.2f} "
            f"vs last3 {m['regret_last3']:.2f}")
    return pd.concat(preds, ignore_index=True), pd.DataFrame(metrics)


def summarize(metrics: pd.DataFrame) -> pd.Series:
    num = metrics.drop(columns=["season", "week"]).select_dtypes("number")
    return num.mean().round(3)


# ----------------------------------------------------------------------------- tuning
def _opportunity_error(h: History, weeks: list[tuple[int, int]], wp: WorkloadParams) -> float:
    """MAE of targets+carries (share estimate x actual team volume) — isolates the share model."""
    errs = []
    pg = h.player_game
    for season, week in weeks:
        hist = history_before(pg, season, week)
        cur = pg[(pg["season"] == season) & (pg["week"] == week) & pg["position"].isin(["RB", "WR", "TE"])]
        if cur.empty:
            continue
        players = cur[["player_id", "position"]].assign(depth_rank=np.nan)
        est = player_shares(hist, players, wp).set_index("player_id")
        c = cur.set_index("player_id")
        pred_t = est["tgt_share"] * c["team_targets"]
        pred_c = est["car_share"] * c["team_carries"]
        errs.append(((pred_t - c["targets"]).abs() + (pred_c - c["carries"]).abs()).mean())
    return float(np.mean(errs))


def tune_workload(h: History, weeks: list[tuple[int, int]], log=print) -> tuple[WorkloadParams, pd.DataFrame]:
    """Grid-search the recent/long blend on the given (earlier) weeks."""
    grid = itertools.product([1, 2, 3, 4, 6], [8, 16, 24], [0.0, 0.25, 0.5, 0.75, 1.0], [0.5, 1, 2, 4])
    rows = []
    for rg, lg, w, pg_ in grid:
        if rg > lg:
            continue
        wp = WorkloadParams(recent_games=rg, long_games=lg, recent_weight=w, prior_games=pg_)
        rows.append({**wp.as_dict(), "opp_mae": _opportunity_error(h, weeks, wp)})
    res = pd.DataFrame(rows).sort_values("opp_mae").reset_index(drop=True)
    b = res.iloc[0]
    best = WorkloadParams(recent_games=int(b.recent_games), long_games=int(b.long_games),
                          recent_weight=float(b.recent_weight), prior_games=float(b.prior_games))
    log(f"best workload params: {best} (opportunity MAE {b.opp_mae:.3f})")
    return best, res


def feature_ablation(h: History, rules: ScoringRules, weeks: list[tuple[int, int]], wp: WorkloadParams,
                     base: EfficiencyFeatures | None = None, n_sims: int = 1500, log=print) -> pd.DataFrame:
    """Toggle each optional feature against the base; promote only what improves unseen weeks."""
    base = base or EfficiencyFeatures(redzone_td_weighting=False, opponent_adjustment=False, vegas_scoring=False)
    variants = {
        "base": base,
        "+redzone": replace(base, redzone_td_weighting=True),
        "+opponent": replace(base, opponent_adjustment=True),
        "+vegas": replace(base, vegas_scoring=True),
    }
    rows = []
    for name, f in variants.items():
        _, m = run_backtest(h, rules, weeks, wp, f, n_sims=n_sims, n_rosters=100, log=lambda *_: None)
        s = summarize(m)
        rows.append({"variant": name, "mae": s["mae_exp_points"], "rmse": s["rmse_exp_points"],
                     "cov80": s["cov80"], "cov50": s["cov50"], "regret": s["regret_exp_points"]})
        log(f"{name:>10}: MAE {s['mae_exp_points']:.3f} regret {s['regret_exp_points']:.3f} cov80 {s['cov80']:.2f}")
    out = pd.DataFrame(rows)
    b = out[out["variant"] == "base"].iloc[0]
    out["promote"] = (out["mae"] < b["mae"]) & (out["regret"] <= b["regret"])
    return out
