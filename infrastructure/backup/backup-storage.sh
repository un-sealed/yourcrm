#!/usr/bin/env bash
# Object-storage backup for YourCRM: mirror the S3/MinIO bucket to local disk
# (which you then snapshot, rsync off-site, or push to a second bucket).
#
# Usage:
#   ./backup-storage.sh
#
# Env:
#   STORAGE_ENDPOINT  e.g. http://localhost:9000 (default)
#   STORAGE_BUCKET    bucket name (default: yourcrm)
#   STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY  credentials (defaults: minioadmin)
#   BACKUP_DIR        Destination root (default: ./backups)
#   MC_IMAGE          MinIO client image (default: quay.io/minio/mc:latest)
#
# Output: $BACKUP_DIR/storage/<bucket>/... (mirror of the bucket)
set -euo pipefail

ENDPOINT="${STORAGE_ENDPOINT:-http://localhost:9000}"
BUCKET="${STORAGE_BUCKET:-yourcrm}"
ACCESS_KEY="${STORAGE_ACCESS_KEY:-minioadmin}"
SECRET_KEY="${STORAGE_SECRET_KEY:-minioadmin}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
MC_IMAGE="${MC_IMAGE:-quay.io/minio/mc:latest}"

DEST_DIR="${BACKUP_DIR}/storage/${BUCKET}"
mkdir -p "${DEST_DIR}"

echo "mirror ${ENDPOINT}/${BUCKET} -> ${DEST_DIR}"
# NOTE: the mc image's entrypoint is `mc` itself, hence --entrypoint sh.
docker run --rm --network host --entrypoint sh \
  -v "${DEST_DIR}:/dest" \
  "${MC_IMAGE}" \
  -c "mc alias set src '${ENDPOINT}' '${ACCESS_KEY}' '${SECRET_KEY}' >/dev/null && mc mirror --overwrite src/${BUCKET} /dest"

echo "OK: $(find "${DEST_DIR}" -type f | wc -l) object(s) in ${DEST_DIR}"
