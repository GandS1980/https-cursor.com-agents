"""Weekly publishing: projections, projection history, roster matching, lineup and waivers."""
from __future__ import annotations

import datetime as dt
import json
import uuid
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from . import db
from .efficiency import EfficiencyFeatures
from .ingest import player_id_map
from .optimizer import optimize_lineup, start_sit, waiver_gains
from .project import History, build_inputs
from .scoring import ScoringRules
from .simulate import SimResult, simulate_slate
from .validate import match_players
from .workload import WorkloadParams

MODEL_VERSION = "v1.0-workload-efficiency-sim"
PARAMS_FILE = db.ROOT / "config/model_params.yaml"
OUT_DIR = db.ROOT / "data/projections"


def load_rules(cfg: dict | None = None) -> ScoringRules:
    cfg = cfg or db.load_league()
    return ScoringRules.from_yaml(db.ROOT / cfg["scoring_file"])


def load_model_params() -> tuple[WorkloadParams, EfficiencyFeatures]:
    if PARAMS_FILE.exists():
        raw = yaml.safe_load(PARAMS_FILE.read_text()) or {}
        return WorkloadParams(**raw.get("workload", {})), EfficiencyFeatures(**raw.get("features", {}))
    return WorkloadParams(), EfficiencyFeatures()


def save_model_params(wp: WorkloadParams, feats: EfficiencyFeatures, evidence: dict) -> None:
    PARAMS_FILE.write_text(yaml.safe_dump({"workload": wp.as_dict(), "features": feats.as_dict(),
                                           "evidence": evidence}, sort_keys=False))


def current_week(h: History, now: dt.datetime | None = None) -> tuple[int, int]:
    now = now or dt.datetime.now()
    pre = h.pregame[h.pregame["kickoff"] >= pd.Timestamp(now) - pd.Timedelta(hours=4)]
    if pre.empty:
        raise ValueError("No upcoming games in schedule")
    first = pre.sort_values("kickoff").iloc[0]
    return int(first["season"]), int(first["week"])


def publish(h: History, season: int, week: int, n_sims: int = 10_000, seed: int = 7,
            overrides: dict[str, str] | None = None, log=print) -> SimResult:
    cfg = db.load_league()
    rules = load_rules(cfg)
    wp, feats = load_model_params()
    inp = build_inputs(h, season, week, wp, feats, cfg)
    res = simulate_slate(inp, rules, n_sims=n_sims, seed=seed, overrides=overrides)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tag = f"{season}_w{week:02d}"
    res.summary.to_parquet(OUT_DIR / f"{tag}.parquet", index=False)
    np.savez_compressed(OUT_DIR / f"{tag}_points.npz", **res.points)

    run_id = uuid.uuid4().hex[:12]
    now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
    cutoff = h.player_game["fetched_at"].max() if "fetched_at" in h.player_game else now
    inp_cols = ["tgt_share", "car_share", "rz_tgt_share", "rz_car_share", "gl_car_share", "att_share",
                "catch_rate", "ypr", "ypc", "games_used", "depth_rank"]
    pin = inp.players.set_index("player_id")
    team_in = inp.teams.set_index("team")
    rows = []
    for _, r in res.summary.iterrows():
        pid = r["player_id"]
        if pid in pin.index:
            d = {c: (None if pd.isna(pin.at[pid, c]) else float(pin.at[pid, c])) for c in inp_cols}
        else:
            d = {}
        t = team_in.loc[r["team"]]
        d.update({"team_attempts": float(t["attempts"]), "team_carries": float(t["carries"]),
                  "implied_total": None if pd.isna(t["implied_total"]) else float(t["implied_total"]),
                  "workload_params": wp.as_dict(), "features": feats.as_dict(), "n_sims": n_sims,
                  "overrides": overrides or {}, "scoring_verified": rules.verified})
        rows.append([run_id, MODEL_VERSION, now, cutoff, season, week, pid, r["player_name"], r["position"],
                     r["team"], r["scenario"], r["p_play"], r["exp_points"], r["p10"], r["p25"], r["p50"],
                     r["p75"], r["p90"], json.dumps(d), None, None])
    con = db.connect(cfg)
    con.executemany("INSERT INTO projection_history VALUES (" + ",".join("?" * 21) + ")", rows)
    con.close()
    log(f"published {len(rows)} projections for {season} week {week} (run {run_id}, {n_sims} sims)")
    return res


def load_published(season: int, week: int) -> tuple[pd.DataFrame, dict[str, np.ndarray]]:
    tag = f"{season}_w{week:02d}"
    s = pd.read_parquet(OUT_DIR / f"{tag}.parquet")
    pts = dict(np.load(OUT_DIR / f"{tag}_points.npz"))
    return s, pts


def resolve_actuals(h: History) -> int:
    """Fill actual Da B.E.S. points into projection_history for completed weeks."""
    from .backtest import actual_points
    rules = load_rules()
    con = db.connect()
    pending = con.execute("SELECT DISTINCT season, week FROM projection_history WHERE actual_points IS NULL").fetchall()
    n = 0
    done_weeks = set(map(tuple, h.player_game[["season", "week"]].drop_duplicates().to_numpy()))
    for season, week in pending:
        if (season, week) not in done_weeks:
            continue
        a = actual_points(h, rules, season, week)
        con.register("act", a)
        con.execute("""UPDATE projection_history p SET actual_points = COALESCE(a.actual, 0),
                       resolved_at = now() FROM (SELECT * FROM act) a
                       WHERE p.player_id = a.player_id AND p.season = ? AND p.week = ?""", [season, week])
        con.execute("""UPDATE projection_history SET actual_points = 0, resolved_at = now()
                       WHERE season = ? AND week = ? AND actual_points IS NULL""", [season, week])
        n += 1
    con.close()
    return n


def load_roster(path: str | Path, summary: pd.DataFrame | None = None) -> pd.DataFrame:
    """Roster CSV: player_name, position, team (or yahoo_id). Returns player_id, player_name, position."""
    r = pd.read_csv(path)
    r = match_players(r, player_id_map())
    missing = r[r["player_id"].isna()]
    if len(missing):
        print("WARNING unmatched roster rows:\n", missing.to_string())
    r = r.dropna(subset=["player_id"])
    r["position"] = r["position"].str.upper().replace({"DST": "DEF", "D/ST": "DEF"})
    return r[["player_id", "player_name", "position"]]


def lineup_report(summary: pd.DataFrame, points: dict[str, np.ndarray], roster: pd.DataFrame) -> dict:
    r = roster.merge(summary.drop(columns=["position", "player_name"]), on="player_id", how="left")
    r["exp_points"] = r["exp_points"].fillna(0.0)  # bye week / not on slate -> 0
    lu = optimize_lineup(r, "exp_points")
    start = pd.DataFrame(lu.slots, columns=["slot", "player_id"]).merge(
        r[["player_id", "player_name", "position", "exp_points", "p10", "p50", "p90", "p_play", "report_status"]],
        on="player_id", how="left")
    # closest start/sit calls: each bench player vs the weakest eligible starter he could replace
    calls = []
    from .optimizer import slot_config
    slots = {s["name"]: s["eligible"] for s in slot_config()}
    for b in lu.bench:
        bpos = r.loc[r["player_id"] == b, "position"].iloc[0]
        cands = [(s, p) for s, p in lu.slots if p and bpos in slots[s]]
        if not cands or b not in points:
            continue
        s, p = min(cands, key=lambda sp: float(r.loc[r["player_id"] == sp[1], "exp_points"].iloc[0]))
        if p in points:
            ss = start_sit(points, p, b)
            calls.append({"starter": p, "bench": b, "slot": s, **ss})
    calls = pd.DataFrame(calls)
    if len(calls):
        names = dict(zip(r["player_id"], r["player_name"]))
        calls["starter"] = calls["starter"].map(names)
        calls["bench"] = calls["bench"].map(names)
        calls = calls.sort_values("p_a_outscores_b")
    return {"lineup": start, "expected_total": lu.expected, "calls": calls,
            "bench": r[r["player_id"].isin(lu.bench)][["player_name", "position", "exp_points", "p10", "p90"]]}


def waiver_report(summary: pd.DataFrame, roster: pd.DataFrame, fa_path: str | Path, top: int = 15) -> pd.DataFrame:
    fa = load_roster(fa_path)
    fa = fa[~fa["player_id"].isin(roster["player_id"])]
    fa = fa.merge(summary.drop(columns=["position", "player_name"]), on="player_id", how="left")
    fa["exp_points"] = fa["exp_points"].fillna(0.0)
    r = roster.merge(summary.drop(columns=["position", "player_name"]), on="player_id", how="left")
    r["exp_points"] = r["exp_points"].fillna(0.0)
    cols = ["player_id", "player_name", "position", "exp_points"]
    res = waiver_gains(r[cols], fa[cols], "exp_points")
    names = dict(zip(r["player_id"], r["player_name"]))
    res["drop_name"] = res["drop"].map(names)
    return res.head(top)
