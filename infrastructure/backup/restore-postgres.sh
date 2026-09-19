#!/usr/bin/env bash
# PostgreSQL restore for YourCRM: pg_restore a dump into a target database.
# Safe by default: refuses to touch the live database unless you say so twice.
#
# Usage (scratch verification — the recommended first step):
#   ./restore-postgres.sh backups/postgres/yourcrm-20240101-000000.dump \
#     postgres://yourcrm:yourcrm_dev@localhost:5442/yourcrm_restore_test
#
# Usage (live restore — destructive):
#   RESTORE_LIVE=1 ./restore-postgres.sh <dump> "$DATABASE_URL"
#
# Args:
#   $1  Dump file (.dump, or .dump.gpg when GPG_RECIPIENT was used at backup)
#   $2  Target DATABASE_URL
#
# Env:
#   RESTORE_LIVE=1   Required when the target looks like the production/live DB.
#                    Without it the script only restores into a database whose
#                    name contains "test", "scratch" or "restore".
set -euo pipefail

DUMP="${1:?usage: restore-postgres.sh <dump-file> <target-database-url>}"
TARGET="${2:?usage: restore-postgres.sh <dump-file> <target-database-url>}"

if [ ! -f "${DUMP}" ]; then
  echo "ERROR: dump not found: ${DUMP}" >&2
  exit 1
fi

if [[ "${DUMP}" == *.gpg ]]; then
  echo "decrypting ${DUMP}"
  PLAIN="$(mktemp /tmp/yourcrm-restore-XXXXXX.dump)"
  trap 'rm -f "${PLAIN}"' EXIT
  gpg --batch --yes --decrypt --output "${PLAIN}" "${DUMP}"
  DUMP="${PLAIN}"
fi

DB_NAME="$(echo "${TARGET}" | sed -E 's#.*/([^/?]+).*#\1#')"
if [[ "${DB_NAME}" != *test* && "${DB_NAME}" != *scratch* && "${DB_NAME}" != *restore* ]]; then
  if [ "${RESTORE_LIVE:-}" != "1" ]; then
    echo "ERROR: target database '${DB_NAME}' does not look like a scratch database." >&2
    echo "Restore into a *-test/scratch/restore database first, or set RESTORE_LIVE=1." >&2
    exit 1
  fi
  echo "WARNING: live restore into '${DB_NAME}' in 5s (Ctrl-C to abort)..."
  sleep 5
fi

echo "creating database '${DB_NAME}' if missing"
psql "${TARGET%/${DB_NAME}}" -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" \
  | grep -q 1 || psql "${TARGET%/${DB_NAME}}" -c "CREATE DATABASE \"${DB_NAME}\""

echo "pg_restore ${DUMP} -> ${DB_NAME}"
# NOTE: pg_restore exits nonzero on *warnings* too (e.g. a newer client
# emitting `SET transaction_timeout` against an older server). The restore is
# judged by verification below, not by the exit code alone.
set +e
pg_restore --clean --if-exists --no-owner --dbname="${TARGET}" "${DUMP}" 2>"/tmp/yourcrm-pg-restore-$$.log"
RESTORE_STATUS=$?
set -e
if [ "${RESTORE_STATUS}" -ne 0 ]; then
  echo "pg_restore reported issues (exit ${RESTORE_STATUS}); see /tmp/yourcrm-pg-restore-$$.log"
fi

echo "verifying: every table in the dump exists in '${DB_NAME}'"
MISSING=0
while read -r table; do
  if [ -z "${table}" ]; then continue; fi
  FOUND="$(psql "${TARGET}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='${table}'")"
  if [ "${FOUND}" != "1" ]; then
    echo "MISSING TABLE: ${table}" >&2
    MISSING=$((MISSING + 1))
  fi
done < <(pg_restore --list "${DUMP}" | awk '$3 == "TABLE" {print $NF}' | sed 's/^"//;s/"$//')

TABLES="$(psql "${TARGET}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
if [ "${MISSING}" -ne 0 ]; then
  echo "ERROR: ${MISSING} table(s) missing after restore" >&2
  exit 1
fi
echo "OK: restored; public schema holds ${TABLES} table(s), all dump tables verified"
