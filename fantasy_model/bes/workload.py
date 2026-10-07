"""Workload baseline: predict opportunities before points.

Opportunity = team volume x player share.
  * Team volume (pass attempts, carries, sacks, FG attempts, TDs) blends a recent window with a
    longer window and shrinks toward the league mean.
  * Player shares (targets, carries, red-zone/goal-line, QB attempts) blend recent and long-term
    share of team volume, then shrink toward a position x depth-chart-rank prior.
  * Teammate availability: shares of inactive/limited players are redistributed to active
    teammates in proportion to their own shares (within position pools).

Blend parameters are NOT hand-set: `bes.backtest.tune_workload` chooses them on later, unseen weeks.
Everything here only reads rows strictly before the target week (see `history_before`).
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np
import pandas as pd

SHARE_STATS = {  # share name -> (player numerator, team denominator)
    "tgt_share": ("targets", "team_targets"),
    "car_share": ("carries", "team_carries"),
    "rz_tgt_share": ("rz_targets", "team_rz_targets"),
    "rz_car_share": ("rz_carries", "team_rz_carries"),
    "gl_car_share": ("gl_carries", "team_gl_carries"),
    "att_share": ("attempts", "team_attempts"),
}
TEAM_STATS = ["attempts", "carries", "sacks_suffered", "passing_tds", "rushing_tds", "fg_att",
              "passing_interceptions", "fumbles_lost", "completions", "passing_yards", "rushing_yards"]


@dataclass(frozen=True)
class WorkloadParams:
    recent_games: int = 3       # recent window (games played)
    long_games: int = 16        # long window (games played, spans seasons)
    recent_weight: float = 0.5  # weight on recent vs long
    prior_games: float = 2.0    # pseudo-games of the position/depth prior
    team_recent_games: int = 4
    team_recent_weight: float = 0.4
    team_prior_games: float = 4.0
    # Skip games where an established player (median snap share >= 0.5) played under this
    # fraction of his usual snaps: an injury exit or ejection, not his role. 0 disables.
    partial_game_frac: float = 0.0  # tested 0.2-0.5 on 2024-25: no gain, so off

    def as_dict(self) -> dict:
        return asdict(self)


def history_before(df: pd.DataFrame, season: int, week: int) -> pd.DataFrame:
    """Rows strictly before (season, week): the only information a pregame model may use."""
    return df[(df["season"] < season) | ((df["season"] == season) & (df["week"] < week))]


def _order(df: pd.DataFrame) -> pd.DataFrame:
    return df.sort_values(["season", "week"])


def _window_ratio(h: pd.DataFrame, key: str, num: str, den: str, n: int) -> pd.DataFrame:
    t = h.groupby(key, sort=False).tail(n)
    g = t.groupby(key)[[num, den]].sum(min_count=1)
    out = pd.DataFrame({"ratio": g[num] / g[den].replace(0, np.nan), "n": t.groupby(key).size()})
    return out


def blend(recent: pd.Series, long: pd.Series, n_long: pd.Series, prior: pd.Series,
          recent_weight: float, prior_games: float) -> pd.Series:
    raw = recent_weight * recent.fillna(long) + (1 - recent_weight) * long
    n = n_long.fillna(0)
    raw = raw.fillna(prior)
    return (n * raw + prior_games * prior) / (n + prior_games)


# ----------------------------------------------------------------------------- priors
DEFAULT_PRIORS = {  # (position, depth_rank) -> share prior; used when no depth history exists
    ("QB", 1): {"att_share": 0.97, "car_share": 0.10},
    ("QB", 2): {"att_share": 0.03, "car_share": 0.01},
    ("RB", 1): {"car_share": 0.55, "tgt_share": 0.10, "rz_car_share": 0.55, "gl_car_share": 0.55, "rz_tgt_share": 0.08},
    ("RB", 2): {"car_share": 0.25, "tgt_share": 0.05, "rz_car_share": 0.22, "gl_car_share": 0.22, "rz_tgt_share": 0.04},
    ("RB", 3): {"car_share": 0.06, "tgt_share": 0.02, "rz_car_share": 0.05, "gl_car_share": 0.05, "rz_tgt_share": 0.01},
    ("WR", 1): {"tgt_share": 0.22, "rz_tgt_share": 0.20, "car_share": 0.01},
    ("WR", 2): {"tgt_share": 0.15, "rz_tgt_share": 0.14, "car_share": 0.01},
    ("WR", 3): {"tgt_share": 0.08, "rz_tgt_share": 0.08},
    ("TE", 1): {"tgt_share": 0.15, "rz_tgt_share": 0.17},
    ("TE", 2): {"tgt_share": 0.04, "rz_tgt_share": 0.05},
}


def prior_for(position: str, depth_rank: float | None, share: str, priors: dict | None = None) -> float:
    priors = priors or DEFAULT_PRIORS
    r = 3 if depth_rank is None or np.isnan(depth_rank) else int(min(max(depth_rank, 1), 3))
    for rr in (r, r + 1, 3, 2):
        v = priors.get((position, rr), {}).get(share)
        if v is not None:
            return v
    return 0.0


def fit_depth_priors(player_game: pd.DataFrame, depth: pd.DataFrame) -> dict:
    """Empirical share priors by (position, depth_rank) from weekly depth charts + realized shares."""
    m = player_game.merge(depth[["season", "week", "player_id", "depth_rank"]], on=["season", "week", "player_id"])
    m["depth_rank"] = m["depth_rank"].clip(upper=3)
    out: dict = {}
    for (pos, r), g in m.groupby(["position", "depth_rank"]):
        out[(pos, int(r))] = {}
        for s, (num, den) in SHARE_STATS.items():
            if num in g and den in g:
                out[(pos, int(r))][s] = float(g[num].sum() / max(g[den].sum(), 1))
    return out


# ----------------------------------------------------------------------------- estimates
def drop_partial_games(h: pd.DataFrame, p: WorkloadParams) -> pd.DataFrame:
    if p.partial_game_frac <= 0 or "offense_pct" not in h:
        return h
    recent = h.groupby("player_id").tail(p.long_games)
    med = recent.groupby("player_id")["offense_pct"].median()
    m = h["player_id"].map(med)
    partial = (m >= 0.5) & (h["offense_pct"] < p.partial_game_frac * m)
    return h[~partial]


def player_shares(hist: pd.DataFrame, players: pd.DataFrame, p: WorkloadParams,
                  priors: dict | None = None) -> pd.DataFrame:
    """Blended share estimates for `players` (player_id, position, depth_rank) from history."""
    h = drop_partial_games(_order(hist), p)
    out = players.set_index("player_id").copy()
    for s, (num, den) in SHARE_STATS.items():
        if num not in h or den not in h:
            out[s] = np.nan
            continue
        rec = _window_ratio(h, "player_id", num, den, p.recent_games)
        lng = _window_ratio(h, "player_id", num, den, p.long_games)
        prior = pd.Series([prior_for(pos, dr, s, priors) for pos, dr in
                           zip(out["position"], out.get("depth_rank", pd.Series(np.nan, index=out.index)))],
                          index=out.index)
        out[s] = blend(rec["ratio"].reindex(out.index), lng["ratio"].reindex(out.index),
                       lng["n"].reindex(out.index), prior, p.recent_weight, p.prior_games).clip(0, 1)
    out["games_used"] = h.groupby("player_id").size().reindex(out.index).fillna(0).clip(upper=p.long_games)
    return out.reset_index()


def team_volume(team_hist: pd.DataFrame, teams: list[str], p: WorkloadParams) -> pd.DataFrame:
    """Blended per-game team volume for each team."""
    h = _order(team_hist)
    league = h.tail(32 * 17)[TEAM_STATS].mean()  # most recent ~season of team-games
    rec = h.groupby("team").tail(p.team_recent_games).groupby("team")[TEAM_STATS].mean()
    lng = h.groupby("team").tail(p.long_games).groupby("team")[TEAM_STATS].mean()
    n = h.groupby("team").tail(p.long_games).groupby("team").size()
    out = pd.DataFrame(index=pd.Index(teams, name="team"))
    for c in TEAM_STATS:
        raw = p.team_recent_weight * rec[c] + (1 - p.team_recent_weight) * lng[c]
        nn = n.reindex(out.index).fillna(0)
        out[c] = (nn * raw.reindex(out.index).fillna(league[c]) + p.team_prior_games * league[c]) / (nn + p.team_prior_games)
    return out.reset_index()


def opponent_factors(team_hist: pd.DataFrame, p: WorkloadParams, shrink_games: float = 8.0) -> pd.DataFrame:
    """Defense-allowed ratio vs league for each stat (1.0 = average). Candidate feature."""
    h = _order(team_hist)
    league = h[TEAM_STATS].mean()
    allowed = h.groupby("opponent_team").tail(p.long_games).groupby("opponent_team")
    m = allowed[TEAM_STATS].mean()
    n = allowed.size()
    ratio = (m / league)
    w = (n / (n + shrink_games)).to_numpy()[:, None]
    return pd.DataFrame(w * ratio.to_numpy() + (1 - w), index=m.index, columns=TEAM_STATS)


# ----------------------------------------------------------------------------- availability
def redistribute(shares: pd.DataFrame, availability: pd.Series, limited_multiplier: float) -> pd.DataFrame:
    """Apply availability ('active'|'limited'|'inactive') and hand vacated share to teammates.

    Pools: targets go to all pass catchers; carries/goal-line go to RB first (QB keeps own runs);
    QB attempts go to the remaining QBs. Redistribution is proportional to each teammate's share.
    """
    s = shares.copy()
    mult = availability.reindex(s["player_id"]).map({"active": 1.0, "limited": limited_multiplier,
                                                    "inactive": 0.0}).fillna(1.0).to_numpy()
    pools = {"tgt_share": ["RB", "WR", "TE"], "rz_tgt_share": ["RB", "WR", "TE"],
             "car_share": ["RB"], "rz_car_share": ["RB"], "gl_car_share": ["RB"], "att_share": ["QB"]}
    for col, pool_pos in pools.items():
        if col not in s:
            continue
        for team, idx in s.groupby("team").groups.items():
            idx = np.asarray(idx)
            base = s.loc[idx, col].fillna(0).to_numpy()
            m = mult[s.index.get_indexer(idx)]
            new = base * m
            vacated = (base - new).sum()
            elig = s.loc[idx, "position"].isin(pool_pos).to_numpy() & (m > 0)
            if vacated > 0 and elig.any():
                w = new * elig
                w = w / w.sum() if w.sum() > 0 else elig / elig.sum()
                new = new + vacated * w
            s.loc[idx, col] = new
    s["availability"] = availability.reindex(s["player_id"]).fillna("active").to_numpy()
    return s


def normalize_team_shares(s: pd.DataFrame, min_other: float = 0.03) -> pd.DataFrame:
    """Keep each team's known shares summing to <= 1 - min_other (the rest goes to 'other')."""
    s = s.copy()
    for col in SHARE_STATS:
        if col not in s or col == "att_share":  # QB start share is a categorical pick, not a split
            continue
        tot = s.groupby("team")[col].transform("sum")
        cap = 1 - min_other
        s[col] = np.where(tot > cap, s[col] * cap / tot, s[col])
    return s
