"""Da B.E.S. scoring: one function for actual and simulated statistics.

`score(stats, rules, position)` accepts
  * a pandas DataFrame (one row per player-game, canonical stat columns, optional `position`), or
  * a mapping of stat name -> numpy array (any shape, e.g. (n_sims,) for one player's simulations).

It returns total points plus a per-rule breakdown, so discrepancies against Yahoo can be traced to
the exact rule responsible. A rule with a nonzero weight whose stat is unavailable yields NaN
(unknown) rather than silently scoring 0; the missing stats are reported.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping
import warnings

import numpy as np
import pandas as pd
import yaml

from .stats import FG_BUCKETS


@dataclass
class Bonus:
    name: str
    stats: list[str]
    thresholds: list[float]
    points: list[float]
    mode: str = "cumulative"


@dataclass
class ScoringRules:
    name: str
    verified: bool
    per_unit: dict[str, float]
    fg_made_by_distance: dict[str, float]
    fg_missed_by_distance: dict[str, float]
    bonuses: list[Bonus]
    dst_points_allowed_tiers: list[tuple[float, float, float]]
    dst_points_allowed_mode: str = "all_points"
    dst_yards_allowed_tiers: list[tuple[float, float, float]] = field(default_factory=list)

    @classmethod
    def from_yaml(cls, path: str | Path) -> "ScoringRules":
        raw = yaml.safe_load(Path(path).read_text())
        rules = cls(
            name=raw["name"],
            verified=bool(raw.get("verified", False)),
            per_unit={k: float(v) for k, v in raw.get("per_unit", {}).items()},
            fg_made_by_distance={str(k): float(v) for k, v in raw.get("fg_made_by_distance", {}).items()},
            fg_missed_by_distance={str(k): float(v) for k, v in raw.get("fg_missed_by_distance", {}).items()},
            bonuses=[Bonus(**b) for b in raw.get("bonuses", [])],
            dst_points_allowed_tiers=[tuple(map(float, t)) for t in raw.get("dst_points_allowed_tiers", [])],
            dst_points_allowed_mode=raw.get("dst_points_allowed_mode", "all_points"),
            dst_yards_allowed_tiers=[tuple(map(float, t)) for t in raw.get("dst_yards_allowed_tiers", [])],
        )
        rules.validate()
        if not rules.verified:
            warnings.warn(f"Scoring rules '{rules.name}' are UNVERIFIED against Yahoo; "
                          "projections may optimize the wrong scoring system.", stacklevel=2)
        return rules

    def validate(self) -> None:
        for fg in (self.fg_made_by_distance, self.fg_missed_by_distance):
            unknown = set(fg) - set(FG_BUCKETS)
            if unknown:
                raise ValueError(f"Unknown FG buckets {unknown}; expected {FG_BUCKETS}")
        for b in self.bonuses:
            if len(b.thresholds) != len(b.points):
                raise ValueError(f"Bonus {b.name}: thresholds and points differ in length")
            if b.mode not in ("cumulative", "highest"):
                raise ValueError(f"Bonus {b.name}: mode must be cumulative|highest")
            if list(b.thresholds) != sorted(b.thresholds):
                raise ValueError(f"Bonus {b.name}: thresholds must ascend")
        if self.dst_points_allowed_mode not in ("all_points", "exclude_dst_scores"):
            raise ValueError("dst_points_allowed_mode must be all_points|exclude_dst_scores")

    def linear_terms(self) -> dict[str, float]:
        """All per-unit terms including FG distance buckets, keyed by canonical stat name."""
        terms = dict(self.per_unit)
        for b, p in self.fg_made_by_distance.items():
            terms[f"fg_made_{b}"] = p
        for b, p in self.fg_missed_by_distance.items():
            terms[f"fg_missed_{b}"] = p
        return terms


@dataclass
class ScoreResult:
    total: np.ndarray | pd.Series
    breakdown: dict[str, np.ndarray | pd.Series]
    missing_stats: set[str]


def _is_dst_stat(stat: str) -> bool:
    return stat.startswith("dst_")


def _tier_points(values: np.ndarray, tiers: list[tuple[float, float, float]]) -> np.ndarray:
    out = np.full(values.shape, np.nan)
    for lo, hi, pts in tiers:
        out = np.where((values >= lo) & (values <= hi), pts, out)
    # values outside every tier score 0, unknown stays unknown
    return np.where(np.isnan(values), np.nan, np.nan_to_num(out, nan=0.0))


def bonus_points(values: np.ndarray, bonus: Bonus) -> np.ndarray:
    pts = np.zeros(values.shape)
    if bonus.mode == "cumulative":
        for t, p in zip(bonus.thresholds, bonus.points):
            pts = pts + np.where(values >= t, p, 0.0)
    else:
        for t, p in zip(bonus.thresholds, bonus.points):
            pts = np.where(values >= t, p, pts)
    return np.where(np.isnan(values), np.nan, pts)


def score(stats: pd.DataFrame | Mapping[str, np.ndarray], rules: ScoringRules,
          position: str | None = None) -> ScoreResult:
    is_df = isinstance(stats, pd.DataFrame)
    if is_df:
        n_shape = (len(stats),)
        if position is not None:
            pos = np.full(n_shape, position, dtype=object)
        elif "position" in stats.columns:
            pos = stats["position"].to_numpy(dtype=object)
        else:
            raise ValueError("DataFrame needs a `position` column or the position argument")
        get = lambda c: stats[c].to_numpy(dtype=float) if c in stats.columns else None  # noqa: E731
    else:
        if position is None:
            raise ValueError("position is required when scoring a mapping of arrays")
        first = next(iter(stats.values()))
        n_shape = np.shape(first)
        pos = np.full(n_shape, position, dtype=object)
        get = lambda c: np.asarray(stats[c], dtype=float) if c in stats else None  # noqa: E731

    is_def = pos == "DEF"
    missing: set[str] = set()
    breakdown: dict[str, np.ndarray] = {}

    def fetch(stat: str) -> np.ndarray:
        v = get(stat)
        if v is None:
            missing.add(stat)
            return np.full(n_shape, np.nan)
        return np.broadcast_to(v, n_shape).astype(float)

    for stat, w in rules.linear_terms().items():
        if w == 0:
            continue
        applies = is_def if _is_dst_stat(stat) else ~is_def
        if not applies.any():
            continue
        pts = fetch(stat) * w
        breakdown[stat] = np.where(applies, pts, 0.0)

    for b in rules.bonuses:
        if not any(b.points) or not (~is_def).any():
            continue
        vals = sum(fetch(s) for s in b.stats)
        breakdown[b.name] = np.where(~is_def, bonus_points(vals, b), 0.0)

    if is_def.any():
        if rules.dst_points_allowed_tiers:
            col = "dst_points_allowed_all" if rules.dst_points_allowed_mode == "all_points" \
                else "dst_points_allowed_excl"
            pa = fetch(col)
            breakdown["dst_points_allowed"] = np.where(is_def, _tier_points(pa, rules.dst_points_allowed_tiers), 0.0)
        if rules.dst_yards_allowed_tiers:
            ya = fetch("dst_yards_allowed")
            breakdown["dst_yards_allowed"] = np.where(is_def, _tier_points(ya, rules.dst_yards_allowed_tiers), 0.0)

    total = np.zeros(n_shape)
    for v in breakdown.values():
        total = total + v  # NaN propagates: an unknown component makes the total unknown

    if is_df:
        idx = stats.index
        return ScoreResult(pd.Series(total, index=idx),
                           {k: pd.Series(v, index=idx) for k, v in breakdown.items()}, missing)
    return ScoreResult(total, breakdown, missing)


def score_frame(df: pd.DataFrame, rules: ScoringRules, with_breakdown: bool = False) -> pd.DataFrame:
    """Convenience: return df with `bes_points` (and optionally `pts_<rule>` columns)."""
    res = score(df, rules)
    out = df.copy()
    out["bes_points"] = res.total
    if with_breakdown:
        for k, v in res.breakdown.items():
            out[f"pts_{k}"] = v
    return out
