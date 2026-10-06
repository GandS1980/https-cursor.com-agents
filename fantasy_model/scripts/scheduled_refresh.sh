#!/usr/bin/env bash
# Scheduled ingestion. Example crontab (America/Chicago):
#   CRON_TZ=America/Chicago
#   17 6 * * 2-4   /path/to/fantasy_model/scripts/scheduled_refresh.sh nightly    # Tue-Thu: stats + injuries
#   47 10 * * 0    /path/to/fantasy_model/scripts/scheduled_refresh.sh gameday    # Sunday before 1pm lock
#   7 17 * * 4     /path/to/fantasy_model/scripts/scheduled_refresh.sh gameday    # Thursday before TNF
set -euo pipefail
cd "$(dirname "$0")/.."
SEASON=$(date +%Y); [ "$(date +%m)" -le 2 ] && SEASON=$((SEASON-1))
case "${1:-nightly}" in
  nightly) python -m bes.cli ingest --seasons "$SEASON" && python -m bes.cli resolve && python -m bes.cli project ;;
  gameday) python -m bes.cli refresh ;;
esac
