import numpy as np
import pandas as pd
import pytest

from bes.efficiency import EfficiencyFeatures
from bes.optimizer import optimize_lineup, waiver_gains
from bes.project import SlateInputs
from bes.scoring import Bonus, ScoringRules
from bes.simulate import _team_block, simulate_slate, SimConfig
from bes.workload import WorkloadParams, history_before, redistribute

SLOTS = [{"name": "QB", "eligible": ["QB"]}, {"name": "RB1", "eligible": ["RB"]}, {"name": "RB2", "eligible": ["RB"]},
         {"name": "WT1", "eligible": ["WR", "TE"]}, {"name": "WT2", "eligible": ["WR", "TE"]},
         {"name": "FLEX", "eligible": ["WR", "RB", "TE"]}, {"name": "K", "eligible": ["K"]},
         {"name": "DEF", "eligible": ["DEF"]}]


def test_history_before_has_no_lookahead():
    df = pd.DataFrame({"season": [2024, 2025, 2025, 2025], "week": [18, 1, 5, 6]})
    h = history_before(df, 2025, 5)
    assert set(zip(h.season, h.week)) == {(2024, 18), (2025, 1)}


def test_optimizer_respects_slots():
    roster = pd.DataFrame({
        "player_id": list("ABCDEFGHIJK"),
        "position": ["QB", "QB", "RB", "RB", "RB", "WR", "WR", "TE", "K", "DEF", "RB"],
        "exp_points": [20, 25, 15, 14, 13, 9, 8, 7, 8, 7, 12],
    })
    lu = optimize_lineup(roster, slots=SLOTS)
    slots = dict(lu.slots)
    assert slots["QB"] == "B"
    assert {slots["RB1"], slots["RB2"]} == {"C", "D"}
    # W/T slots cannot hold an RB even though RBs project higher
    assert {slots["WT1"], slots["WT2"]} == {"F", "G"}
    assert slots["FLEX"] == "E"  # best remaining W/R/T
    assert lu.expected == pytest.approx(25 + 15 + 14 + 9 + 8 + 13 + 8 + 7)


def test_optimizer_leaves_unfillable_slot_empty():
    roster = pd.DataFrame({"player_id": ["A", "B"], "position": ["QB", "RB"], "exp_points": [10, 5]})
    lu = optimize_lineup(roster, slots=SLOTS)
    assert dict(lu.slots)["K"] is None


def test_waiver_gain_is_over_displaced_player():
    roster = pd.DataFrame({"player_id": ["Q", "R1", "R2", "W1", "W2", "T", "K", "D", "BN"],
                           "position": ["QB", "RB", "RB", "WR", "WR", "TE", "K", "DEF", "WR"],
                           "exp_points": [20, 12, 11, 10, 9, 6, 8, 7, 2]})
    fa = pd.DataFrame({"player_id": ["FA_TE", "FA_K"], "position": ["TE", "K"], "exp_points": [10.0, 9.0],
                       "player_name": ["te", "k"]})
    res = waiver_gains(roster, fa, slots=SLOTS).set_index("add")
    # FA TE (10) replaces the FLEX/WT-level 6-9 players: lineup gain 10 - 6 = 4, not 10
    assert res.loc["FA_TE", "lineup_gain"] == pytest.approx(4)
    assert res.loc["FA_K", "lineup_gain"] == pytest.approx(1)
    assert res.loc["FA_K", "drop"] == "K" or res.loc["FA_K", "drop"] == "BN"


def test_redistribution_conserves_share():
    s = pd.DataFrame({"player_id": ["a", "b", "c", "q"], "team": "X", "position": ["WR", "WR", "TE", "QB"],
                      "tgt_share": [0.3, 0.2, 0.1, 0.0], "car_share": [0, 0, 0, 0.1], "att_share": [0, 0, 0, 1]})
    out = redistribute(s, pd.Series({"a": "inactive"}), 0.65)
    assert out["tgt_share"].sum() == pytest.approx(0.6)
    assert out.set_index("player_id").at["a", "tgt_share"] == 0
    assert out.set_index("player_id").at["b", "tgt_share"] == pytest.approx(0.2 + 0.3 * 2 / 3)


def _toy_slate():
    players = pd.DataFrame({
        "player_id": ["qa", "ra", "wa", "ta", "ka", "qb", "rb", "wb", "kb", "qa2"],
        "player_name": list("ABCDEFGHIJ"),
        "team": ["A"] * 5 + ["B"] * 4 + ["A"],
        "position": ["QB", "RB", "WR", "TE", "K", "QB", "RB", "WR", "K", "QB"],
        "p_play": [1, 1, 0.5, 1, 1, 1, 1, 1, 1, 1], "report_status": [None] * 10,
        "tgt_share": [0, 0.12, 0.28, 0.18, 0, 0, 0.15, 0.3, 0, 0],
        "car_share": [0.1, 0.6, 0.02, 0, 0, 0.1, 0.65, 0, 0, 0.01],
        "rz_tgt_share": 0.1, "rz_car_share": 0.3, "gl_car_share": 0.3,
        "att_share": [0.97, 0, 0, 0, 0, 1, 0, 0, 0, 0.03],
        "catch_rate": 0.65, "ypr": 10.0, "ypc": 4.3, "fumble_per_touch": 0.004, "two_pt_per_game": 0.02,
        "rec_td_w": 1.0, "rush_td_w": 1.0, "rush_td_rate_w": 1.0, "int_rate": 0.02, "returner": False, "ret_yds_mu": 0.0,
        "fg_make_mult": 1.0,
    })
    teams = pd.DataFrame({"team": ["A", "B"], "opponent": ["B", "A"], "game_id": ["g", "g"],
                          "attempts": 34.0, "carries": 26.0, "sacks_suffered": 2.3, "passing_tds": 1.5,
                          "rushing_tds": 0.9, "fg_att": 1.8, "implied_total": [24, 20],
                          "opp_pass_ypa_f": 1.0, "opp_rush_ypc_f": 1.0, "opp_td_f": 1.0, "score_scale": 1.0,
                          "dst_tds": 0.15, "dst_return_tds": 0.04, "dst_safeties": 0.02, "dst_blocked_kicks": 0.05,
                          "dst_return_yards": 60.0})
    league = {"other_catch_rate": 0.65, "other_ypr": 10.0, "other_ypc": 4.2, "pat_make": 0.95,
              "fg_bucket_p": np.array([0.02, 0.25, 0.3, 0.25, 0.18]), "fg_make_p": np.array([1, .97, .92, .82, .7])}
    return SlateInputs(2026, 6, players, teams, league, WorkloadParams(), EfficiencyFeatures())


def _rules():
    return ScoringRules(
        name="t", verified=True,
        per_unit={"receptions": 1, "receiving_yards": 0.1, "rushing_yards": 0.1, "receiving_tds": 6, "rushing_tds": 6,
                  "passing_yards": 0.04, "passing_tds": 4, "completions": 0.5, "carries": 0.2, "pat_made": 1,
                  "dst_sacks": 1, "dst_interceptions": 2, "dst_fumble_recoveries": 2, "dst_tds": 6},
        fg_made_by_distance={"0_19": 3, "20_29": 3, "30_39": 3, "40_49": 4, "50_plus": 5},
        fg_missed_by_distance={}, bonuses=[Bonus("rec100", ["receiving_yards"], [100], [3])],
        dst_points_allowed_tiers=[(0, 0, 10), (1, 13, 5), (14, 999, 0)])


def test_simulation_structural_invariants():
    inp = _toy_slate()
    rng = np.random.default_rng(1)
    team = inp.teams.set_index("team").loc["A"]
    tp = inp.players[inp.players.team == "A"].reset_index(drop=True)
    u = np.ones(4000)
    ps, tot = _team_block(rng, team, tp, inp, 4000, u, {}, SimConfig(), inp.features)
    rec = sum(ps[p]["receptions"] for p in ps)
    comp = ps["qa"]["completions"] + ps["qa2"]["completions"]
    for p in ps:
        assert (ps[p]["receptions"] <= ps[p]["targets"]).all()
        assert (ps[p]["receiving_tds"] <= ps[p]["receptions"]).all()
        assert (ps[p]["rushing_tds"] <= ps[p]["carries"]).all()
    # completions = all receptions (incl. 'other' bucket) >= receptions of known players
    assert (comp + 1e-9 >= rec).all()
    # exactly one QB starts each game
    started = (ps["qa"]["attempts"] > 0).astype(int) + (ps["qa2"]["attempts"] > 0).astype(int)
    assert started.max() <= 1
    # 50% questionable WR: no targets in roughly half the sims, and teammates pick them up
    off = ps["wa"]["targets"] == 0
    assert 0.4 < off.mean() < 0.6
    assert ps["ta"]["targets"][off].mean() > ps["ta"]["targets"][~off].mean()


def test_simulate_slate_outputs_and_scenarios():
    inp = _toy_slate()
    r = simulate_slate(inp, _rules(), n_sims=3000, seed=3)
    s = r.summary.set_index("player_id")
    assert {"DEF_A", "DEF_B"} <= set(s.index)
    assert (s["p10"] <= s["p50"]).all() and (s["p50"] <= s["p90"]).all()
    assert 0 <= s.at["wa", "p_rec100_100"] <= 1
    assert 0 <= r.prob_a_beats_b("wa", "ta") <= 1
    r_out = simulate_slate(inp, _rules(), n_sims=3000, seed=3, overrides={"wa": "inactive"})
    r_in = simulate_slate(inp, _rules(), n_sims=3000, seed=3, overrides={"wa": "active"})
    so, si = r_out.summary.set_index("player_id"), r_in.summary.set_index("player_id")
    assert so.at["wa", "exp_points"] == 0
    assert so.at["ta", "exp_points"] > si.at["ta", "exp_points"]
