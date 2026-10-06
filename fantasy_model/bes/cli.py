"""Command line: python -m bes.cli <command> [options]

  ingest             nflverse -> Parquet/DuckDB
  validate-scoring   compare Da B.E.S. scoring to completed Yahoo scores (do this FIRST)
  calibrate-injuries empirical P(play | injury designation)
  tune               choose workload blend on earlier weeks; ablate optional features on later weeks
  backtest           chronological backtest vs baselines (point error, calibration, lineup regret)
  project            publish this week's projections (+ projection history)
  lineup             optimal legal lineup + closest start/sit calls
  waivers            free-agent gain over the player displaced
  scenarios          active / limited / inactive for one player and teammates
  refresh            ingest current season + Firecrawl + project + lineup (run before lineup lock)
  resolve            write actual points into projection history
"""
from __future__ import annotations

import argparse
import sys
import warnings

import pandas as pd

from . import db

pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 30)


def _weeks(h, seasons: list[int], start_week: int = 3) -> list[tuple[int, int]]:
    done = h.player_game[["season", "week"]].drop_duplicates()
    done = done[done["season"].isin(seasons) & (done["week"] >= start_week)]
    return [tuple(map(int, x)) for x in done.sort_values(["season", "week"]).to_numpy()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="bes", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("ingest"); p.add_argument("--seasons", type=int, nargs="*"); p.add_argument("--no-pbp", action="store_true")
    p = sub.add_parser("validate-scoring"); p.add_argument("--yahoo", default=None)
    sub.add_parser("calibrate-injuries")
    p = sub.add_parser("tune"); p.add_argument("--tune-seasons", type=int, nargs="+", default=[2024])
    p.add_argument("--test-seasons", type=int, nargs="+", default=[2025]); p.add_argument("--sims", type=int, default=1500)
    p = sub.add_parser("backtest"); p.add_argument("--seasons", type=int, nargs="+", default=[2025, 2026])
    p.add_argument("--sims", type=int, default=2000); p.add_argument("--out", default="data/backtest")
    for name in ("project", "lineup", "waivers", "scenarios", "refresh"):
        p = sub.add_parser(name); p.add_argument("--season", type=int); p.add_argument("--week", type=int)
        p.add_argument("--sims", type=int, default=None)
        p.add_argument("--inactive", nargs="*", default=[], help="player names to force inactive")
        p.add_argument("--limited", nargs="*", default=[], help="player names to force limited")
        if name == "scenarios":
            p.add_argument("--player", required=True)
    sub.add_parser("resolve")
    a = ap.parse_args(argv)
    cfg = db.load_league()

    if a.cmd == "ingest":
        from .ingest import ingest
        ingest(a.seasons or cfg["history_seasons"], include_pbp=not a.no_pbp)
        return 0

    from .project import History, calibrate_play_probability
    from . import pipeline as P
    h = History.load()

    if a.cmd == "validate-scoring":
        from .validate import validate
        path = a.yahoo or db.ROOT / cfg["inputs"]["yahoo_actual_scores"]
        res = validate(str(path), P.load_rules(cfg), h)
        m = res["all"]
        print(f"rows: {len(m)} | mismatches: {len(res['mismatches'])} | unmatched names: {len(res['unmatched'])}")
        print(res["by_position"].to_string(index=False))
        if len(res["mismatches"]):
            cols = ["season", "week", "player_id", "player_name", "position", "yahoo_points", "bes_points", "diff"]
            cols = [c for c in cols if c in res["mismatches"]] + [c for c in res["mismatches"] if c.startswith("pts_")]
            print(res["mismatches"][cols].head(40).to_string(index=False))
        if len(res["inferred_corrections"]):
            print("\nInferred rule corrections (yahoo - ours regressed on stats):")
            print(res["inferred_corrections"].to_string(index=False))
            print("residual MAE after applying:", res["inferred_corrections"].attrs.get("residual_mae_after_fix"))
        if len(res["unmatched"]):
            print("\nUnmatched rows:\n", res["unmatched"].head(20).to_string(index=False))
        return 0 if len(res["mismatches"]) == 0 else 1

    if a.cmd == "calibrate-injuries":
        t = calibrate_play_probability(h)
        print(t.to_string())
        print("\nCopy these into config/league.yaml -> play_probability if sample sizes are adequate.")
        return 0

    if a.cmd == "tune":
        from .backtest import feature_ablation, tune_workload
        wp, grid = tune_workload(h, _weeks(h, a.tune_seasons))
        grid.head(15).to_csv(db.ROOT / "data/tune_workload_top.csv", index=False)
        abl = feature_ablation(h, P.load_rules(cfg), _weeks(h, a.test_seasons), wp, n_sims=a.sims)
        print(abl.to_string(index=False))
        from .efficiency import EfficiencyFeatures
        promoted = set(abl.loc[abl["promote"], "variant"])
        feats = EfficiencyFeatures(redzone_td_weighting="+redzone" in promoted,
                                   opponent_adjustment="+opponent" in promoted,
                                   vegas_scoring="+vegas" in promoted)
        P.save_model_params(wp, feats, {"tune_seasons": a.tune_seasons, "test_seasons": a.test_seasons,
                                        "ablation": abl.round(3).to_dict(orient="records")})
        print(f"saved {P.PARAMS_FILE}: {wp} {feats}")
        return 0

    if a.cmd == "backtest":
        from .backtest import run_backtest, summarize
        from pathlib import Path
        wp, feats = P.load_model_params()
        roster = None
        rp = db.ROOT / cfg["inputs"]["roster"]
        if rp.exists():
            roster = P.load_roster(rp)
        extra = None
        yp = db.ROOT / cfg["inputs"]["yahoo_projections"]
        if yp.exists():
            from .validate import yahoo_projection_baseline
            extra = yahoo_projection_baseline(str(yp), P.load_rules(cfg))
        preds, metrics = run_backtest(h, P.load_rules(cfg), _weeks(h, a.seasons), wp, feats, n_sims=a.sims,
                                      my_roster=roster, extra_baselines=extra)
        out = db.ROOT / a.out
        Path(out).mkdir(parents=True, exist_ok=True)
        preds.to_parquet(out / "predictions.parquet", index=False)
        metrics.to_csv(out / "metrics.csv", index=False)
        print("\n=== mean over weeks ===")
        print(summarize(metrics).to_string())
        return 0

    if a.cmd == "resolve":
        print(f"resolved {P.resolve_actuals(h)} week(s)")
        return 0

    season, week = (a.season, a.week) if a.season and a.week else P.current_week(h)
    sims = a.sims or cfg["simulation"]["n_sims"]
    overrides = {}
    if a.inactive or a.limited:
        from .validate import match_players
        from .ingest import player_id_map
        ids = player_id_map()
        for status, names in (("inactive", a.inactive), ("limited", a.limited)):
            if names:
                mm = match_players(pd.DataFrame({"player_name": names}), ids)
                overrides.update({pid: status for pid in mm["player_id"].dropna()})

    if a.cmd == "refresh":
        from .ingest import ingest
        ingest([season], include_pbp=True)
        try:
            from .firecrawl import run_sources
            run_sources(season, week)
        except RuntimeError as e:
            print(f"firecrawl skipped: {e}")
        h = History.load()
        P.resolve_actuals(h)
        a.cmd = "lineup"

    if a.cmd in ("project", "lineup", "waivers"):
        res = P.publish(h, season, week, n_sims=sims, overrides=overrides)
        if a.cmd == "project":
            print(res.summary.groupby("position").head(12)[["player_name", "position", "team", "exp_points", "p10", "p50", "p90", "p_play"]].to_string(index=False))
            return 0
        rp = db.ROOT / cfg["inputs"]["roster"]
        if not rp.exists():
            print(f"Put your roster in {rp} (see data/inputs/README.md)")
            return 1
        roster = P.load_roster(rp)
        if a.cmd == "lineup":
            rep = P.lineup_report(res.summary, res.points, roster)
            print(f"\n=== Optimal lineup {season} week {week}: {rep['expected_total']:.2f} expected ===")
            print(rep["lineup"].to_string(index=False))
            print("\nBench:\n" + rep["bench"].to_string(index=False))
            if len(rep["calls"]):
                print("\nClosest calls (P starter outscores bench):\n" + rep["calls"].head(8).to_string(index=False))
            return 0
        fp = db.ROOT / cfg["inputs"]["free_agents"]
        if not fp.exists():
            print(f"Waivers need your league's available players in {fp}")
            return 1
        print(P.waiver_report(res.summary, roster, fp).to_string(index=False))
        return 0

    if a.cmd == "scenarios":
        from .simulate import injury_scenarios
        from .validate import match_players
        from .ingest import player_id_map
        from .project import build_inputs
        pid = match_players(pd.DataFrame({"player_name": [a.player]}), player_id_map())["player_id"].iloc[0]
        if pd.isna(pid):
            print(f"player not found: {a.player}")
            return 1
        wp, feats = P.load_model_params()
        inp = build_inputs(h, season, week, wp, feats, cfg)
        print(injury_scenarios(inp, P.load_rules(cfg), pid, n_sims=min(sims, 5000)).to_string(index=False))
        return 0
    return 0


if __name__ == "__main__":
    warnings.filterwarnings("once")
    sys.exit(main())
