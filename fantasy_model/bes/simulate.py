"""Monte Carlo simulation of a full weekly slate, scored with Da B.E.S. rules.

Structure preserved in every simulated game:
  * team passing volume determines receiver opportunities (targets ~ multinomial of attempts);
  * receptions <= targets, touchdowns <= touches, QB completions/yards/TDs = sum over receivers;
  * a player's absence (drawn from P(play) or forced by a scenario) redistributes his share to
    teammates *in the same simulated game*;
  * a shared game factor correlates both offenses (shootouts), and a DEF's points allowed,
    sacks and takeaways come from the simulated opposing offense.

`n_sims` is a precision setting only — it does not fix weak inputs.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .project import SlateInputs
from .scoring import ScoringRules, score
from .stats import FG_BUCKETS


@dataclass(frozen=True)
class SimConfig:
    share_concentration: float = 30.0   # Dirichlet concentration of weekly share noise
    volume_sd: float = 0.14             # lognormal sd of team play volume
    game_sd: float = 0.18               # shared game-environment scoring factor
    team_sd: float = 0.30               # team-specific scoring factor
    rec_yards_shape: float = 0.75       # gamma shape per reception (yards per catch CV ~1.15)
    rush_yards_sd: float = 6.0          # per-carry yards sd
    limited_multiplier: float = 0.65
    def_td_per_turnover_cap: float = 0.25


@dataclass
class SimResult:
    season: int
    week: int
    n_sims: int
    points: dict[str, np.ndarray]
    summary: pd.DataFrame
    overrides: dict[str, str] = field(default_factory=dict)

    def prob_a_beats_b(self, a: str, b: str) -> float:
        pa, pb = self.points[a], self.points[b]
        return float(np.mean(pa > pb) + 0.5 * np.mean(pa == pb))


def _lognorm(rng, sd, size):
    return np.exp(rng.normal(0, sd, size) - 0.5 * sd * sd)


def _redistribute(base: np.ndarray, mult: np.ndarray, elig: np.ndarray) -> np.ndarray:
    """base (P,), mult (n,P) in [0,1], elig (P,) -> per-sim shares (n,P)."""
    new = base[None, :] * mult
    vacated = (base[None, :] - new).sum(axis=1)
    w = new * elig[None, :]
    ws = w.sum(axis=1, keepdims=True)
    fallback = elig / elig.sum() if elig.any() else np.zeros_like(base)
    w = np.where(ws > 0, w / np.where(ws > 0, ws, 1), fallback[None, :])
    return new + vacated[:, None] * w


def _alloc(rng, total: np.ndarray, weights: np.ndarray, cap: np.ndarray) -> np.ndarray:
    """Allocate integer events (n,) across columns by weights (n,K), never exceeding cap (n,K)."""
    ws = weights.sum(axis=1, keepdims=True)
    ok = ws[:, 0] > 0
    p = np.where(ok[:, None], weights / np.where(ws > 0, ws, 1), 1.0 / weights.shape[1])
    out = rng.multinomial(np.where(ok, total, 0), p)
    return np.minimum(out, cap)


def _team_block(rng, team_row, tp: pd.DataFrame, inp: SlateInputs, n: int, u: np.ndarray,
                overrides: dict[str, str], cfg: SimConfig, feats) -> tuple[dict, dict]:
    """Simulate one offense. Returns (player_stats {pid: {stat: arr}}, team_totals {name: arr})."""
    lg = inp.league
    P = len(tp)
    pos = tp["position"].to_numpy()

    # availability multipliers per sim
    mult = np.ones((n, P))
    for j, (pid, pp) in enumerate(zip(tp["player_id"], tp["p_play"].fillna(1.0))):
        ov = overrides.get(pid)
        if ov == "inactive":
            mult[:, j] = 0.0
        elif ov == "limited":
            mult[:, j] = cfg.limited_multiplier
        elif ov == "active":
            mult[:, j] = 1.0
        elif pp < 1.0:
            mult[:, j] = (rng.random(n) < pp).astype(float)
    active = (mult > 0).astype(float)

    def shares(col, pool):
        base = tp[col].fillna(0).to_numpy(dtype=float)
        return _redistribute(base, mult, np.isin(pos, pool))

    tgt = shares("tgt_share", ["RB", "WR", "TE"])
    car = shares("car_share", ["RB"])
    att = shares("att_share", ["QB"])
    # One QB starts each simulated game (drawn by attempt share among available QBs) and takes
    # the team's passing and QB runs. A fractional split would give backups phantom points.
    qb = pos == "QB"
    if qb.any():
        qb_cols = np.where(qb)[0]
        w = att[:, qb_cols] + 1e-12 * active[:, qb_cols]
        cum = np.cumsum(w / w.sum(axis=1, keepdims=True), axis=1)
        pick = (rng.random(n)[:, None] > cum).sum(axis=1).clip(max=len(qb_cols) - 1)
        starter = np.zeros((n, P))
        starter[np.arange(n), qb_cols[pick]] = 1.0
        any_qb = w.sum(axis=1) > 1e-9
        starter[~any_qb] = 0.0
        att = starter
        car[:, qb] = tp["car_share"].fillna(0).to_numpy()[qb][None, :] * starter[:, qb]

    # team volume
    pass_mult = _lognorm(rng, cfg.volume_sd, n) * u ** -0.15
    rush_mult = _lognorm(rng, cfg.volume_sd, n) * u ** 0.25
    pass_att = rng.poisson(team_row["attempts"] * pass_mult)
    rush_att = rng.poisson(team_row["carries"] * rush_mult)

    def with_other(s):
        other = np.clip(1 - s.sum(axis=1, keepdims=True), 0.02, None)
        p = np.concatenate([s, other], axis=1)
        p = p / p.sum(axis=1, keepdims=True)
        noisy = rng.gamma(cfg.share_concentration * p + 1e-9)
        return noisy / noisy.sum(axis=1, keepdims=True)

    targets = rng.multinomial(pass_att, with_other(tgt))          # (n, P+1)
    carries = rng.multinomial(rush_att, with_other(car))          # (n, P+1)

    catch = np.append(tp["catch_rate"].fillna(lg["other_catch_rate"]).to_numpy(), lg["other_catch_rate"])
    rec = rng.binomial(targets, catch[None, :])
    ypr = np.append(tp["ypr"].fillna(lg["other_ypr"]).to_numpy(), lg["other_ypr"]) * team_row["opp_pass_ypa_f"]
    ypr = ypr[None, :] * u[:, None] ** 0.15
    k = cfg.rec_yards_shape
    rec_yds = rng.gamma(rec * k + 1e-12, ypr / k) * (rec > 0)
    ypc = np.append(tp["ypc"].fillna(lg["other_ypc"]).to_numpy(), lg["other_ypc"]) * team_row["opp_rush_ypc_f"]
    shift = 3.0
    kc = (ypc + shift) ** 2 / cfg.rush_yards_sd ** 2
    th = cfg.rush_yards_sd ** 2 / (ypc + shift)
    rush_yds = (rng.gamma(carries * kc[None, :] + 1e-12, th[None, :]) - shift * carries) * (carries > 0)

    scale = team_row["score_scale"] * team_row["opp_td_f"]
    pass_td_team = rng.poisson(team_row["passing_tds"] * scale * u)
    rush_td_team = rng.poisson(team_row["rushing_tds"] * scale * u)
    if feats.redzone_td_weighting:
        rw = np.append(tp["rec_td_w"].fillna(1).to_numpy(), 1.0)
        cw = np.append(tp["rush_td_w"].fillna(1).to_numpy(), 1.0)
    else:
        rw = cw = np.ones(P + 1)
    rec_td = _alloc(rng, pass_td_team, rec * rw[None, :], rec)
    rush_td = _alloc(rng, rush_td_team, carries * cw[None, :], carries)

    fpt = np.append(tp["fumble_per_touch"].fillna(0.004).to_numpy(), 0.004)
    fum = rng.poisson((carries + rec) * fpt[None, :])

    # team passing totals -> QBs by attempt share
    comp_tot, pyds_tot, ptd_tot = rec.sum(1), rec_yds.sum(1), rec_td.sum(1)
    qb_idx = np.where(qb)[0]
    int_rate = float(tp.loc[qb, "int_rate"].mean()) if qb.any() else 0.023
    ints = rng.binomial(pass_att, int_rate)
    sacks = rng.poisson(team_row["sacks_suffered"] * pass_mult)

    out: dict[str, dict[str, np.ndarray]] = {}
    att_sum = np.maximum(att[:, qb].sum(1), 1e-9) if qb.any() else None
    for j, pid in enumerate(tp["player_id"]):
        a = active[:, j]
        s = {
            "targets": targets[:, j], "receptions": rec[:, j], "receiving_yards": rec_yds[:, j],
            "receiving_tds": rec_td[:, j], "carries": carries[:, j], "rushing_yards": rush_yds[:, j],
            "rushing_tds": rush_td[:, j], "fumbles_lost": fum[:, j],
            "two_pt_conversions": rng.poisson(tp["two_pt_per_game"].iloc[j], n) * a,
            "return_yards": (rng.gamma(2.0, max(tp["ret_yds_mu"].iloc[j], 1e-6) / 2.0, n)
                             if tp["returner"].iloc[j] else np.zeros(n)) * a,
            "return_tds": (rng.poisson(0.008, n) if tp["returner"].iloc[j] else np.zeros(n)) * a,
            "offensive_fumble_return_tds": np.zeros(n),
            "completions": np.zeros(n), "attempts": np.zeros(n), "incompletions": np.zeros(n),
            "passing_yards": np.zeros(n), "passing_tds": np.zeros(n), "passing_interceptions": np.zeros(n),
            "sacks_suffered": np.zeros(n), "pat_made": np.zeros(n), "pat_missed": np.zeros(n),
        }
        for b in FG_BUCKETS:
            s[f"fg_made_{b}"] = np.zeros(n)
            s[f"fg_missed_{b}"] = np.zeros(n)
        if pos[j] == "QB":
            frac = att[:, j] / att_sum
            s["attempts"] = pass_att * frac
            s["completions"] = comp_tot * frac
            s["incompletions"] = s["attempts"] - s["completions"]
            s["passing_yards"] = pyds_tot * frac
            s["passing_tds"] = ptd_tot * frac
            s["passing_interceptions"] = ints * frac
            s["sacks_suffered"] = sacks * frac
        out[pid] = s

    # kicker(s): the healthiest kicker takes the kicks
    pat_att = pass_td_team + rush_td_team
    two_pt_tot = sum(out[p]["two_pt_conversions"] for p in out)
    kidx = np.where(pos == "K")[0]
    fg_mu = team_row["fg_att"] * np.sqrt(team_row["score_scale"]) * np.sqrt(u)
    fg_att = rng.poisson(fg_mu)
    fg_made_tot = np.zeros(n)
    pat_made_tot = rng.binomial(pat_att, lg["pat_make"])
    if len(kidx):
        j = kidx[np.argmax(tp["p_play"].to_numpy()[kidx])]
        mult_k = tp["fg_make_mult"].iloc[j]
        buckets = rng.multinomial(fg_att, lg["fg_bucket_p"])
        for bi, b in enumerate(FG_BUCKETS):
            made = rng.binomial(buckets[:, bi], np.clip(lg["fg_make_p"][bi] * mult_k, 0, 0.995))
            out[tp["player_id"].iloc[j]][f"fg_made_{b}"] = made
            out[tp["player_id"].iloc[j]][f"fg_missed_{b}"] = buckets[:, bi] - made
            fg_made_tot = fg_made_tot + made
        out[tp["player_id"].iloc[j]]["pat_made"] = pat_made_tot
        out[tp["player_id"].iloc[j]]["pat_missed"] = pat_att - pat_made_tot
    else:
        fg_made_tot = rng.binomial(fg_att, 0.85)

    other_fum = fum[:, -1]
    fum_team = sum(out[p]["fumbles_lost"] for p in out) + other_fum
    totals = {
        "off_points": 6 * (pass_td_team + rush_td_team) + pat_made_tot + 3 * fg_made_tot + 2 * two_pt_tot,
        "ints": ints, "fumbles_lost": fum_team, "sacks": sacks,
    }
    return out, totals


def simulate_slate(inp: SlateInputs, rules: ScoringRules, n_sims: int = 10_000, seed: int = 7,
                   overrides: dict[str, str] | None = None, cfg: SimConfig | None = None,
                   keep_points: bool = True) -> SimResult:
    cfg = cfg or SimConfig()
    overrides = overrides or {}
    rng = np.random.default_rng(seed)
    n = n_sims
    teams = inp.teams.set_index("team")
    game_f = {g: rng.normal(size=n) for g in teams["game_id"].unique()}
    u = {}
    for t, row in teams.iterrows():
        z = cfg.game_sd * game_f[row["game_id"]] + cfg.team_sd * rng.normal(size=n)
        u[t] = np.exp(z - 0.5 * (cfg.game_sd ** 2 + cfg.team_sd ** 2))

    player_stats: dict[str, dict] = {}
    team_tot: dict[str, dict] = {}
    for t, row in teams.iterrows():
        tp = inp.players[inp.players["team"] == t].reset_index(drop=True)
        ps, tot = _team_block(rng, row, tp, inp, n, u[t], overrides, cfg, inp.features)
        player_stats.update(ps)
        team_tot[t] = tot

    # DEF events first (needed for opponents' points allowed), then DEF stat lines
    dev = {}
    for t, row in teams.iterrows():
        o = row["opponent"]
        turnovers = team_tot[o]["ints"] + team_tot[o]["fumbles_lost"]
        p_td = float(np.clip(row["dst_tds"] / 1.35, 0, cfg.def_td_per_turnover_cap))
        dev[t] = {
            "dst_tds": rng.binomial(turnovers, p_td),
            "dst_return_tds": rng.poisson(row["dst_return_tds"], n),
            "dst_safeties": rng.poisson(row["dst_safeties"], n),
            "dst_blocked_kicks": rng.poisson(row["dst_blocked_kicks"], n),
            "dst_return_yards": rng.gamma(4.0, max(row["dst_return_yards"], 1e-6) / 4.0, n),
            "dst_extra_point_returns": rng.poisson(row.get("dst_extra_point_returns", 0.004), n),
        }
    for t, row in teams.iterrows():
        o = row["opponent"]
        excl = team_tot[o]["off_points"]
        allp = excl + 7 * (dev[o]["dst_tds"] + dev[o]["dst_return_tds"]) + 2 * dev[o]["dst_safeties"]
        player_stats[f"DEF_{t}"] = {
            **dev[t], "dst_sacks": team_tot[o]["sacks"], "dst_interceptions": team_tot[o]["ints"],
            "dst_fumble_recoveries": team_tot[o]["fumbles_lost"],
            "dst_points_allowed_all": allp, "dst_points_allowed_excl": excl,
        }

    # score + summarize
    meta = inp.players.set_index("player_id")
    rows, points = [], {}
    for pid, stats in player_stats.items():
        is_def = pid.startswith("DEF_")
        position = "DEF" if is_def else meta.at[pid, "position"]
        res = score(stats, rules, position)
        pts = res.total.astype(np.float32)
        if keep_points:
            points[pid] = pts
        q = np.nanpercentile(pts, [10, 25, 50, 75, 90])
        team = pid[4:] if is_def else meta.at[pid, "team"]
        row = {
            "player_id": pid, "player_name": f"{team} DEF" if is_def else meta.at[pid, "player_name"],
            "team": team, "opponent": teams.at[team, "opponent"], "position": position,
            "exp_points": float(np.nanmean(pts)), "p10": q[0], "p25": q[1], "p50": q[2], "p75": q[3], "p90": q[4],
            "sd": float(np.nanstd(pts)),
            "p_play": 1.0 if is_def else float(meta.at[pid, "p_play"]),
            "report_status": None if is_def else meta.at[pid, "report_status"],
            "scenario": overrides.get(pid, "probabilistic"),
        }
        for b in rules.bonuses:
            vals = sum(np.asarray(stats.get(s, np.zeros(n)), dtype=float) for s in b.stats)
            for thr in b.thresholds:
                row[f"p_{b.name}_{int(thr)}"] = float(np.mean(vals >= thr))
        for s in ("attempts", "completions", "passing_yards", "passing_tds", "carries", "rushing_yards",
                  "rushing_tds", "targets", "receptions", "receiving_yards", "receiving_tds"):
            if not is_def:
                row[f"mu_{s}"] = float(np.mean(stats[s]))
        if res.missing_stats:
            row["missing_stats"] = ",".join(sorted(res.missing_stats))
        rows.append(row)
    summary = pd.DataFrame(rows).sort_values("exp_points", ascending=False).reset_index(drop=True)
    return SimResult(inp.season, inp.week, n, points, summary, overrides)


def injury_scenarios(inp: SlateInputs, rules: ScoringRules, player_id: str, n_sims: int = 5000,
                     seed: int = 11, cfg: SimConfig | None = None) -> pd.DataFrame:
    """Active / limited / inactive scenarios for one player: his line and his teammates' changes."""
    from dataclasses import replace
    team = inp.players.loc[inp.players["player_id"] == player_id, "team"].iloc[0]
    opp = inp.teams.loc[inp.teams["team"] == team, "opponent"].iloc[0]
    game = [team, opp]  # only this game needs re-simulating
    inp = replace(inp, players=inp.players[inp.players["team"].isin(game)],
                  teams=inp.teams[inp.teams["team"].isin(game)])
    mates = inp.players.loc[inp.players["team"] == team, "player_id"].tolist() + [f"DEF_{opp}"]
    out = []
    for sc in ("active", "limited", "inactive"):
        r = simulate_slate(inp, rules, n_sims, seed, {player_id: sc}, cfg, keep_points=False)
        s = r.summary[r.summary["player_id"].isin(mates)][["player_id", "player_name", "position", "exp_points", "p10", "p90"]]
        out.append(s.assign(scenario=sc))
    df = pd.concat(out)
    wide = df.pivot_table(index=["player_id", "player_name", "position"], columns="scenario", values="exp_points")
    wide["delta_if_inactive"] = wide["inactive"] - wide["active"]
    return wide.reset_index().sort_values("delta_if_inactive", ascending=False)
