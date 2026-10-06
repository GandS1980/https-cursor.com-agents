# Da B.E.S. projection & lineup model (v1)

Python model for a Yahoo league with custom scoring. Built in the order that matters:
**scoring → data → workload → efficiency → simulation → lineup → proof.**

| Component | Implementation |
|---|---|
| Data ingestion | nflverse release files (`bes/ingest.py`); Firecrawl for injury news & outside projections (`bes/firecrawl.py`) |
| Storage | Parquet (system of record) + DuckDB views and append-only tables (`bes/db.py`) |
| Calculations | pandas |
| Prediction | Shrunk recent/long blends (v1); gradient boosting slots in later behind the same backtest gate |
| Simulation | NumPy, full-slate joint simulation (`bes/simulate.py`) |
| Dashboard | Streamlit (`app.py`) |
| Updates | `scripts/scheduled_refresh.sh` (cron) + manual refresh (CLI `refresh` or dashboard button) |

## Quick start

```bash
cd fantasy_model
pip install -r requirements.txt
python -m bes.cli ingest                       # 2023–2026 nflverse -> data/parquet + data/bes.duckdb
python -m bes.cli validate-scoring             # needs data/inputs/yahoo_actual_scores.csv  <- DO THIS FIRST
python -m bes.cli tune                         # choose blend on 2024, ablate features on 2025
python -m bes.cli backtest --seasons 2025 2026 # point error, calibration, lineup regret vs baselines
python -m bes.cli lineup                       # needs data/inputs/my_roster.csv
python -m bes.cli scenarios --player "Puka Nacua"
python -m bes.cli waivers                      # needs data/inputs/free_agents.csv
streamlit run app.py
python -m pytest
```

## 1. Scoring (`config/scoring_da_bes.yaml`, `bes/scoring.py`)

One function, `score(stats, rules, position)`, scores a DataFrame of real stat lines **or** a dict of
simulated NumPy arrays. It covers per-unit stats (completions, incompletions, carries, PPR, targets,
yards, TDs, turnovers, return yards, 2-pt), cumulative or highest-tier yardage bonuses on any sum of stats,
FG made/missed by distance bucket, and DEF points-allowed / yards-allowed tiers.

* A rule with a nonzero weight whose stat is unavailable produces **NaN, not 0**, and is reported.
* `verified: false` in the YAML prints a warning everywhere until validation passes.
* `validate-scoring` reports every mismatched player-week with the per-rule breakdown **and regresses
  (Yahoo − ours) on each stat to infer which weights are wrong**.

> The current YAML values are placeholders. The league's exact rule values were not available when
> this was built. Fill them in from Yahoo › League › Settings, then validate.

## 2. Datasets (`bes/datasets.py`)

| Dataset | Contents | Source |
|---|---|---|
| `player_game` | carries, targets, receptions, yards, TDs, air yards, EPA, snaps, red-zone / goal-line / end-zone opportunities, team shares | nflverse player stats + snap counts + play-by-play |
| `pregame` | opponent, home/away, kickoff, stadium, roof, surface, rest, spread, total, implied team totals | nflverse schedules |
| player context | final injury designation, depth-chart rank as of kickoff | nflverse injuries, depth charts (timestamped since 2025) |
| `projection_history` | every published projection, its inputs (JSON), data cutoff, model version, and later the actual result | DuckDB |

Rules enforced: GSIS ids everywhere (Yahoo/PFR/Sleeper crosswalk from rosters); a game not played is
a missing row, not zeros; snap-only appearances are real zeros; `history_before()` is the only door
to training data. **Routes / YPRR are NaN columns** until a verified charting feed exists.
nflverse temp/wind are *observed* values, flagged `observed_postgame_not_for_backtest`, and are not used.

## 3–4. Workload and efficiency (`bes/workload.py`, `bes/efficiency.py`)

Opportunities = team volume × player share. Shares blend a recent window with a long window and shrink
to a position × depth-chart prior. The window lengths, recent weight, and prior strength are **chosen
by grid search on earlier weeks** (`tune`), not hand-set. Teammate availability redistributes vacated
share inside position pools.

Efficiency is separate: catch rate, yards/reception, yards/carry, TD weights, fumble rate, and INT rate,
each shrunk to the position mean with pseudo-counts. Optional features (red-zone TD weighting,
opponent adjustment, Vegas-anchored scoring) are toggled by `feature_ablation` and **promoted only if
they lower MAE without raising lineup regret on later weeks**.

## 5. Simulation (`bes/simulate.py`)

Each simulated game draws team volume (sharing a game factor with the opponent), then:
targets ~ Dirichlet-multinomial(pass attempts), receptions ~ Binomial(targets), yards ~ Gamma sums,
TDs allocated only to players with touches, one QB starts and gets the team's passing,
questionable players sit in a share of the sims, and their workload goes to teammates *in those same sims*.
DEF sacks, takeaways, and points allowed come from the simulated opposing offense.

Outputs per player: expected points, p10/25/50/75/90, yardage-bonus probabilities,
P(A outscores B) from paired sims, and active / limited / inactive scenarios with teammate deltas.

## 6. Lineup (`bes/optimizer.py`)

Exact assignment over `QB · RB · RB · W/T · W/T · W/R/T · K · DEF` (W/T excludes RBs). Objective v1:
expected points. `win_probability()` is in place for the v2 opponent-aware objective.
Waivers report **lineup gain over the player displaced**, not the free agent's raw projection.

## 7. Proof (`bes/backtest.py`)

Chronological: each week is predicted using only earlier data. Metrics: MAE/RMSE/bias on
fantasy-relevant players, 80%/50% interval coverage, and lineup regret on 200 fixed synthetic rosters
(and on your roster if provided). Baselines: last-3-games points, Yahoo projections scored under
Da B.E.S. rules (if `yahoo_projections.csv` is supplied), and outside projections (Firecrawl).

## Deferred to later versions (data or benefit not yet verified)

Route charting / YPRR · weather-forecast effects (needs a forecast feed and stadium coordinates) ·
opponent-lineup simulation for win-probability optimization · QB-change effects on receiver efficiency
· gradient-boosted models · rest-of-season waiver value · Yahoo API (OAuth) instead of CSV exports.
