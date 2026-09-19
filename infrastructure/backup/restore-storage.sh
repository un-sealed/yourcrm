#!/usr/bin/env bash
# Object-storage restore for YourCRM: mirror a local backup back into a bucket.
# Defaults to a scratch bucket so a restore is always verifiable before it is
# trusted; overwriting the live bucket requires RESTORE_LIVE=1.
#
# Usage (scratch verification):
#   ./restore-storage.sh ./backups/storage/yourcrm yourcrm_restore_test
#
# Usage (live restore — destructive):
#   RESTORE_LIVE=1 ./restore-storage.sh ./backups/storage/yourcrm yourcrm
#
# Args:
#   $1  Local backup directory (a previous backup-storage.sh output)
#   $2  Target bucket name
set -euo pipefail

SRC_DIR="${1:?usage: restore-storage.sh <backup-dir> <target-bucket>}"
TARGET_BUCKET="${2:?usage: restore-storage.sh <backup-dir> <target-bucket>}"

ENDPOINT="${STORAGE_ENDPOINT:-http://localhost:9000}"
ACCESS_KEY="${STORAGE_ACCESS_KEY:-minioadmin}"
SECRET_KEY="${STORAGE_SECRET_KEY:-minioadmin}"
MC_IMAGE="${MC_IMAGE:-quay.io/minio/mc:latest}"

if [ ! -d "${SRC_DIR}" ]; then
  echo "ERROR: backup dir not found: ${SRC_DIR}" >&2
  exit 1
fi

if [[ "${TARGET_BUCKET}" != *test* && "${TARGET_BUCKET}" != *scratch* && "${TARGET_BUCKET}" != *restore* ]]; then
  if [ "${RESTORE_LIVE:-}" != "1" ]; then
    echo "ERROR: target bucket '${TARGET_BUCKET}' does not look like a scratch bucket." >&2
    echo "Restore into a *-test/scratch/restore bucket first, or set RESTORE_LIVE=1." >&2
    exit 1
  fi
  echo "WARNING: live restore into bucket '${TARGET_BUCKET}' in 5s (Ctrl-C to abort)..."
  sleep 5
fi

ABS_SRC="$(cd "${SRC_DIR}" && pwd)"
echo "mirror ${ABS_SRC} -> ${ENDPOINT}/${TARGET_BUCKET}"
# NOTE: the mc image's entrypoint is `mc` itself, hence --entrypoint sh.
docker run --rm --network host --entrypoint sh \
  -v "${ABS_SRC}:/src:ro" \
  "${MC_IMAGE}" \
  -c "mc alias set dst '${ENDPOINT}' '${ACCESS_KEY}' '${SECRET_KEY}' >/dev/null && mc mb --ignore-existing dst/${TARGET_BUCKET} && mc mirror --overwrite /src dst/${TARGET_BUCKET}"

echo "OK: restored into bucket ${TARGET_BUCKET}"
