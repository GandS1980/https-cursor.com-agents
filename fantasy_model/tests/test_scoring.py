import numpy as np
import pandas as pd
import pytest

from bes.scoring import Bonus, ScoringRules, bonus_points, score, score_frame
from bes.stats import add_derived_stats


def rules(**kw):
    base = dict(
        name="t", verified=True,
        per_unit={"completions": 0.5, "carries": 0.2, "receptions": 1.0, "passing_yards": 0.04,
                  "rushing_yards": 0.1, "receiving_yards": 0.1, "passing_tds": 4, "rushing_tds": 6,
                  "receiving_tds": 6, "passing_interceptions": -2, "fumbles_lost": -2, "return_yards": 0.05,
                  "pat_made": 1, "dst_sacks": 1, "dst_interceptions": 2},
        fg_made_by_distance={}, fg_missed_by_distance={},
        bonuses=[Bonus("rush_bonus", ["rushing_yards"], [100, 150, 200], [3, 3, 3], "cumulative")],
        dst_points_allowed_tiers=[(0, 0, 10), (1, 6, 7), (7, 13, 4), (14, 20, 1), (21, 27, 0), (28, 999, -4)],
    )
    base.update(kw)
    return ScoringRules(**base)


def test_linear_rules_rb_line():
    stats = {"carries": np.array([20.0]), "rushing_yards": np.array([95.0]), "rushing_tds": np.array([1.0]),
             "receptions": np.array([3.0]), "receiving_yards": np.array([22.0]), "receiving_tds": np.array([0.0]),
             "fumbles_lost": np.array([1.0]), "return_yards": np.array([40.0]),
             "completions": np.zeros(1), "passing_yards": np.zeros(1), "passing_tds": np.zeros(1),
             "passing_interceptions": np.zeros(1), "pat_made": np.zeros(1)}
    for b in ("0_19", "20_29", "30_39", "40_49", "50_plus"):
        stats[f"fg_made_{b}"] = np.zeros(1)
        stats[f"fg_missed_{b}"] = np.zeros(1)
    r = score(stats, rules(), "RB")
    # 20*.2 + 95*.1 + 6 + 3 + 2.2 - 2 + 40*.05 = 4 + 9.5 + 6 + 3 + 2.2 - 2 + 2 = 24.7
    assert r.total[0] == pytest.approx(24.7)
    assert not r.missing_stats


def test_cumulative_vs_highest_bonus():
    v = np.array([99, 100, 160, 210.0])
    cum = bonus_points(v, Bonus("b", ["x"], [100, 150, 200], [3, 3, 3], "cumulative"))
    hi = bonus_points(v, Bonus("b", ["x"], [100, 150, 200], [3, 5, 8], "highest"))
    assert cum.tolist() == [0, 3, 6, 9]
    assert hi.tolist() == [0, 3, 5, 8]


def test_combined_stat_bonus_sums_sources():
    b = Bonus("scrim", ["rushing_yards", "receiving_yards"], [100], [2], "cumulative")
    r = rules(bonuses=[b], per_unit={})
    df = pd.DataFrame({"position": ["RB"], "rushing_yards": [60.0], "receiving_yards": [45.0]})
    assert score(df, r).total.iloc[0] == 2


def test_kicking_by_distance_from_nflverse_columns():
    df = pd.DataFrame({"position": ["K"], "fg_made_0_19": [0], "fg_made_20_29": [1], "fg_made_30_39": [1],
                       "fg_made_40_49": [1], "fg_made_50_59": [1], "fg_made_60_": [1],
                       "fg_missed_0_19": [0], "fg_missed_20_29": [1], "fg_missed_30_39": [0], "fg_missed_40_49": [0],
                       "fg_missed_50_59": [1], "fg_missed_60_": [0], "pat_made": [2]})
    df = add_derived_stats(df)
    r = rules(per_unit={"pat_made": 1}, bonuses=[],
              fg_made_by_distance={"0_19": 3, "20_29": 3, "30_39": 3, "40_49": 4, "50_plus": 5},
              fg_missed_by_distance={"0_19": -3, "20_29": -2, "30_39": -1, "40_49": 0, "50_plus": 0})
    # made: 3+3+4+5+5 = 20 ; missed 20-29: -2 ; pat 2 -> 20
    assert score(df, r).total.iloc[0] == pytest.approx(20)


def test_missing_stat_is_unknown_not_zero():
    df = pd.DataFrame({"position": ["WR"], "receptions": [5.0]})  # no yards column at all
    res = score(df, rules(bonuses=[], per_unit={"receptions": 1, "receiving_yards": 0.1}))
    assert np.isnan(res.total.iloc[0])
    assert "receiving_yards" in res.missing_stats


def test_zero_weight_rule_does_not_require_stat():
    df = pd.DataFrame({"position": ["WR"], "receptions": [5.0]})
    res = score(df, rules(bonuses=[], per_unit={"receptions": 1, "routes": 0.0}))
    assert res.total.iloc[0] == 5


def test_def_rules_only_apply_to_def_rows():
    df = pd.DataFrame({"position": ["DEF", "WR"], "dst_sacks": [3, np.nan], "dst_interceptions": [1, np.nan],
                       "dst_points_allowed_all": [10, np.nan], "receptions": [np.nan, 4.0]})
    r = rules(bonuses=[], per_unit={"receptions": 1, "dst_sacks": 1, "dst_interceptions": 2})
    t = score(df, r).total
    assert t.iloc[0] == 3 + 2 + 4  # 7-13 allowed tier = 4
    assert t.iloc[1] == 4


def test_points_allowed_mode_switch():
    df = pd.DataFrame({"position": ["DEF"], "dst_points_allowed_all": [14], "dst_points_allowed_excl": [7]})
    r1 = rules(bonuses=[], per_unit={})
    r2 = rules(bonuses=[], per_unit={}, dst_points_allowed_mode="exclude_dst_scores")
    assert score(df, r1).total.iloc[0] == 1
    assert score(df, r2).total.iloc[0] == 4


def test_simulated_arrays_shape_preserved():
    n = 1000
    stats = {"receptions": np.full(n, 5.0), "receiving_yards": np.linspace(0, 200, n)}
    r = rules(bonuses=[Bonus("rec", ["receiving_yards"], [100], [3])], per_unit={"receptions": 1, "receiving_yards": 0.1})
    res = score(stats, r, "WR")
    assert res.total.shape == (n,)
    assert res.total[-1] == pytest.approx(5 + 20 + 3)


def test_yaml_config_loads_and_validates(tmp_path):
    from bes.db import ROOT
    with pytest.warns(UserWarning):
        r = ScoringRules.from_yaml(ROOT / "config/scoring_da_bes.yaml")
    assert r.per_unit["receptions"] == 1.0
    bad = tmp_path / "bad.yaml"
    bad.write_text("name: x\nbonuses:\n  - {name: b, stats: [x], thresholds: [200, 100], points: [1, 1]}\n")
    with pytest.raises(ValueError):
        ScoringRules.from_yaml(bad)


def test_score_frame_breakdown_columns():
    df = pd.DataFrame({"position": ["WR"], "receptions": [2.0], "receiving_yards": [10.0]})
    out = score_frame(df, rules(bonuses=[], per_unit={"receptions": 1, "receiving_yards": 0.1}), with_breakdown=True)
    assert out["bes_points"].iloc[0] == 3
    assert out["pts_receptions"].iloc[0] == 2
