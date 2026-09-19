#!/usr/bin/env bash
# PostgreSQL backup for YourCRM: pg_dump (custom format) + retention pruning.
#
# Usage:
#   DATABASE_URL=postgres://yourcrm:yourcrm_dev@localhost:5442/yourcrm \
#   BACKUP_DIR=/var/backups/yourcrm ./backup-postgres.sh
#
# Env:
#   DATABASE_URL      Postgres connection string (required)
#   BACKUP_DIR        Destination directory (default: ./backups)
#   RETENTION_DAYS    Delete dumps older than N days (default: 14)
#   GPG_RECIPIENT     If set, encrypt the dump with `gpg --encrypt -r <recipient>`
#                     and delete the plaintext dump.
#
# Output: $BACKUP_DIR/postgres/yourcrm-YYYYmmdd-HHMMSS.dump[.gpg]
set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required (see .env.example)}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
DEST_DIR="${BACKUP_DIR}/postgres"
mkdir -p "${DEST_DIR}"
DUMP="${DEST_DIR}/yourcrm-${STAMP}.dump"

echo "pg_dump -> ${DUMP}"
pg_dump --format=custom --no-owner --dbname="${DATABASE_URL}" --file="${DUMP}"

if [ ! -s "${DUMP}" ]; then
  echo "ERROR: dump is empty, refusing to continue" >&2
  rm -f "${DUMP}"
  exit 1
fi

if [ -n "${GPG_RECIPIENT:-}" ]; then
  echo "encrypting for ${GPG_RECIPIENT}"
  gpg --batch --yes --trust-model always --encrypt --recipient "${GPG_RECIPIENT}" \
    --output "${DUMP}.gpg" "${DUMP}"
  rm -f "${DUMP}"
  DUMP="${DUMP}.gpg"
fi

echo "pruning dumps older than ${RETENTION_DAYS} days"
find "${DEST_DIR}" -maxdepth 1 -name 'yourcrm-*.dump*' -mtime "+${RETENTION_DAYS}" -delete || true

echo "OK: ${DUMP} ($(du -h "${DUMP}" | cut -f1))"
