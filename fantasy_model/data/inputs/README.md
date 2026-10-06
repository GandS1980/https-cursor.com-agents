# Inputs you supply (Yahoo exports)

The nflverse data is downloaded automatically; these files come from your Yahoo league. Names are
matched to nflverse GSIS ids via the `yahoo_id` crosswalk or normalized names. Team defenses use
`position=DEF` plus the NFL `team` abbreviation (e.g. `PIT`).

| File | Needed for | Columns |
|---|---|---|
| `my_roster.csv` | lineup, waivers, regret on your roster | `player_name, position, team` (or `yahoo_id`) |
| `yahoo_actual_scores.csv` | **scoring validation (do first)** | `season, week, player_name, position, team, yahoo_points` (or `yahoo_id`) |
| `free_agents.csv` | waiver recommendations | same as roster |
| `yahoo_projections.csv` | Yahoo baseline in backtests | `season, week, player_name, position, team,` + projected stats with canonical names (`completions, passing_yards, passing_tds, passing_interceptions, carries, rushing_yards, rushing_tds, receptions, receiving_yards, receiving_tds, fumbles_lost, return_yards, fg_made_0_19 … fg_made_50_plus, pat_made, dst_sacks, …`) |

For validation, use 50+ completed player-weeks spanning every position, including a kicker
with a 50+ yard FG, a player who crossed a yardage-bonus threshold, a fumble, and a returner.
`*.example.csv` files show the format.
