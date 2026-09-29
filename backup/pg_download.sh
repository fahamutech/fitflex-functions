#!/usr/bin/env bash
# Usage: DB_SERVER=user@host ./backup/pg_download.sh
# Downloaded files must never be committed.
set -euo pipefail
: ${DB_SERVER:?Set DB_SERVER to user@host of the backup server}
scp $DB_SERVER:~/fitflex.dump .
scp $DB_SERVER:~/roles.sql .
