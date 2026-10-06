"""Da B.E.S. lineup dashboard.  Run:  streamlit run app.py"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
import streamlit as st

from bes import db
from bes import pipeline as P
from bes.project import History, build_inputs

warnings.filterwarnings("ignore")
st.set_page_config(page_title="Da B.E.S. Lineups", layout="wide")
cfg = db.load_league()


@st.cache_resource(show_spinner="Loading history…")
def history() -> History:
    return History.load()


h = history()
rules = P.load_rules(cfg)
if not rules.verified:
    st.error("Scoring rules are UNVERIFIED against Yahoo. Run `python -m bes.cli validate-scoring` "
             "and fix config/scoring_da_bes.yaml before trusting rankings.")

season0, week0 = P.current_week(h)
c1, c2, c3, c4 = st.columns([1, 1, 1, 2])
season = c1.number_input("Season", value=season0, step=1)
week = c2.number_input("Week", value=week0, min_value=1, max_value=22, step=1)
sims = c3.selectbox("Simulations", [2000, 5000, 10000, 25000], index=2,
                    help="Precision only — more sims do not fix weak inputs.")
with c4:
    st.write("")
    refresh = st.button("Manual refresh (re-ingest current season + re-project)", type="primary")

if refresh:
    from bes.ingest import ingest
    with st.spinner("Ingesting latest nflverse data…"):
        ingest([int(season)], include_pbp=True, log=lambda *_: None)
    st.cache_resource.clear()
    h = history()
    with st.spinner("Simulating slate…"):
        P.publish(h, int(season), int(week), n_sims=int(sims), log=lambda *_: None)

try:
    summary, points = P.load_published(int(season), int(week))
except FileNotFoundError:
    if st.button("No projections published for this week — publish now"):
        P.publish(h, int(season), int(week), n_sims=int(sims), log=lambda *_: None)
        st.rerun()
    st.stop()

roster_path = db.ROOT / cfg["inputs"]["roster"]
roster = P.load_roster(roster_path) if roster_path.exists() else None

tabs = st.tabs(["My lineup", "Start / sit", "Projections", "Injury scenarios", "Waivers", "Backtest"])

with tabs[0]:
    if roster is None:
        st.info(f"Add your roster to `{roster_path}` (columns: player_name, position, team).")
    else:
        rep = P.lineup_report(summary, points, roster)
        st.metric("Expected starting-lineup points", f"{rep['expected_total']:.1f}")
        st.dataframe(rep["lineup"].round(2), hide_index=True, width="stretch")
        st.subheader("Bench")
        st.dataframe(rep["bench"].round(2), hide_index=True, width="stretch")
        if len(rep["calls"]):
            st.subheader("Closest calls")
            st.caption("Probability the current starter outscores the bench player, from paired simulations.")
            st.dataframe(rep["calls"].round(3), hide_index=True, width="stretch")

with tabs[1]:
    pool = summary if roster is None else summary[summary["player_id"].isin(roster["player_id"])]
    label = {r.player_id: f"{r.player_name} ({r.position}, {r.team})" for r in summary.itertuples()}
    opts = pool["player_id"].tolist()
    if len(opts) >= 2:
        a = st.selectbox("Player A", opts, format_func=label.get, index=0)
        b = st.selectbox("Player B", opts, format_func=label.get, index=1)
        pa, pb = points[a], points[b]
        p = float(np.mean(pa > pb) + 0.5 * np.mean(pa == pb))
        m1, m2, m3 = st.columns(3)
        m1.metric(f"P({label[a].split(' (')[0]} outscores)", f"{p:.1%}")
        m2.metric("Expected difference", f"{np.mean(pa - pb):+.2f}")
        m3.metric("Median difference", f"{np.median(pa - pb):+.2f}")
        bins = np.linspace(min(pa.min(), pb.min()), np.percentile(np.r_[pa, pb], 99.5), 40)
        hist = pd.DataFrame({label[a]: np.histogram(pa, bins)[0], label[b]: np.histogram(pb, bins)[0]},
                            index=np.round(bins[:-1], 1))
        st.bar_chart(hist)

with tabs[2]:
    pos = st.multiselect("Positions", ["QB", "RB", "WR", "TE", "K", "DEF"], default=["QB", "RB", "WR", "TE"])
    view = summary[summary["position"].isin(pos)]
    base = ["player_name", "position", "team", "opponent", "exp_points", "p10", "p25", "p50", "p75", "p90",
            "p_play", "report_status"]
    bonus = [c for c in view.columns if c.startswith("p_") and c != "p_play" and view[c].fillna(0).max() > 0]
    mus = [c for c in view.columns if c.startswith("mu_")]
    st.dataframe(view[base + bonus + mus].round(3), hide_index=True, width="stretch", height=600)

with tabs[3]:
    off = summary[summary["position"] != "DEF"]
    pid = st.selectbox("Player", off["player_id"].tolist(), format_func=label.get)
    if st.button("Run active / limited / inactive"):
        from bes.simulate import injury_scenarios
        wp, feats = P.load_model_params()
        inp = build_inputs(h, int(season), int(week), wp, feats, cfg)
        with st.spinner("Simulating scenarios…"):
            st.dataframe(injury_scenarios(inp, rules, pid, n_sims=4000).round(2), hide_index=True,
                         width="stretch")

with tabs[4]:
    fa_path = db.ROOT / cfg["inputs"]["free_agents"]
    if roster is None or not fa_path.exists():
        st.info(f"Waivers need your roster and your league's available players in `{fa_path}`.")
    else:
        st.caption("Gain = new optimal lineup minus current optimal lineup (vs. the player displaced).")
        st.dataframe(P.waiver_report(summary, roster, fa_path).round(2), hide_index=True, width="stretch")

with tabs[5]:
    mp = db.ROOT / "data/backtest/metrics.csv"
    if mp.exists():
        m = pd.read_csv(mp)
        st.dataframe(m.drop(columns=["season", "week"]).mean().round(3).to_frame("mean").T, width="stretch")
        st.line_chart(m.set_index(m["season"].astype(str) + "-w" + m["week"].astype(str).str.zfill(2))
                      [[c for c in m.columns if c.startswith("regret_")]])
        st.line_chart(m.set_index(m["season"].astype(str) + "-w" + m["week"].astype(str).str.zfill(2))[["cov80", "cov50"]])
    else:
        st.info("Run `python -m bes.cli backtest` to populate.")
