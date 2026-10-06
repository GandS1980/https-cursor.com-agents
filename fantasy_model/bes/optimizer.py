"""Legal lineup optimization for QB · RB · RB · W/T · W/T · W/R/T · K · DEF.

v1 objective: maximize expected total points (exact, via assignment). Because simulations are
paired across players, any lineup's full points distribution is available too, so the
win-probability objective can be tested later against an opponent's simulated lineup.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.optimize import linear_sum_assignment

from .db import load_league

NEG = -1e9


@dataclass
class Lineup:
    slots: list[tuple[str, str]]      # (slot name, player_id)
    expected: float
    bench: list[str]

    def player_ids(self) -> list[str]:
        return [p for _, p in self.slots if p is not None]


def slot_config(cfg: dict | None = None) -> list[dict]:
    return (cfg or load_league())["lineup_slots"]


def optimize_lineup(roster: pd.DataFrame, value_col: str = "exp_points",
                    slots: list[dict] | None = None, locked_out: set[str] | None = None) -> Lineup:
    """roster: player_id, position, <value_col>. Exact maximum of the sum over legal assignments."""
    slots = slots or slot_config()
    r = roster.copy()
    if locked_out:
        r = r[~r["player_id"].isin(locked_out)]
    r = r.reset_index(drop=True)
    vals = r[value_col].fillna(0).to_numpy(dtype=float)
    # cost matrix: slots x players (+ one dummy "empty" column per slot)
    S, P = len(slots), len(r)
    cost = np.full((S, P + S), 0.0)
    for i, s in enumerate(slots):
        elig = r["position"].isin(s["eligible"]).to_numpy()
        cost[i, :P] = np.where(elig, -vals, -NEG)
        cost[i, P:] = 0.0  # leaving a slot empty scores 0 (and is only chosen if nothing eligible)
        cost[i, P:][np.arange(S) != i] = -NEG
    rows, cols = linear_sum_assignment(cost)
    chosen, total = [], 0.0
    for i, c in zip(rows, cols):
        if c < P:
            chosen.append((slots[i]["name"], r.at[c, "player_id"]))
            total += vals[c]
        else:
            chosen.append((slots[i]["name"], None))
    used = {p for _, p in chosen}
    bench = [p for p in r["player_id"] if p not in used]
    return Lineup(chosen, total, bench)


def lineup_points(lineup: Lineup, points: dict[str, np.ndarray]) -> np.ndarray:
    ids = lineup.player_ids()
    n = len(next(iter(points.values())))
    return np.sum([points[p] for p in ids if p in points], axis=0) if ids else np.zeros(n)


def start_sit(points: dict[str, np.ndarray], a: str, b: str) -> dict:
    pa, pb = points[a], points[b]
    return {"p_a_outscores_b": float(np.mean(pa > pb) + 0.5 * np.mean(pa == pb)),
            "exp_diff": float(np.mean(pa - pb)), "median_diff": float(np.median(pa - pb))}


def win_probability(my_lineup: Lineup, opp_lineup: Lineup, points: dict[str, np.ndarray],
                    my_fixed: float = 0.0, opp_fixed: float = 0.0) -> float:
    """P(my total > opponent total) using paired simulations (v2 objective; needs opp roster)."""
    mine = lineup_points(my_lineup, points) + my_fixed
    theirs = lineup_points(opp_lineup, points) + opp_fixed
    return float(np.mean(mine > theirs) + 0.5 * np.mean(mine == theirs))


def waiver_gains(roster: pd.DataFrame, free_agents: pd.DataFrame, value_col: str = "exp_points",
                 slots: list[dict] | None = None, protected: set[str] | None = None) -> pd.DataFrame:
    """For each free agent: best lineup gain when he replaces the least costly roster player.

    Gain is measured against the current optimal lineup — not the free agent's raw projection.
    """
    slots = slots or slot_config()
    protected = protected or set()
    base = optimize_lineup(roster, value_col, slots).expected
    rows = []
    for _, fa in free_agents.iterrows():
        best = (-np.inf, None)
        for drop in roster["player_id"]:
            if drop in protected:
                continue
            trial = pd.concat([roster[roster["player_id"] != drop], fa.to_frame().T], ignore_index=True)
            trial[value_col] = trial[value_col].astype(float)
            v = optimize_lineup(trial, value_col, slots).expected
            if v > best[0]:
                best = (v, drop)
        rows.append({"add": fa["player_id"], "add_name": fa.get("player_name"), "position": fa["position"],
                     "fa_points": float(fa[value_col]), "drop": best[1], "lineup_gain": best[0] - base})
    return pd.DataFrame(rows).sort_values("lineup_gain", ascending=False).reset_index(drop=True)
