# Backups

Postgres (`pg_dump`, custom format) plus an object-storage bucket mirror.
Restore scripts default to **scratch targets** (`*-test/scratch/restore` in
the name) and refuse live targets unless `RESTORE_LIVE=1` is set.

## Scripts

| Script                | Purpose                                              |
| --------------------- | ---------------------------------------------------- |
| `backup-postgres.sh`  | `pg_dump -Fc` the live DB, prune by `RETENTION_DAYS` |
| `backup-storage.sh`   | `mc mirror` the bucket to `$BACKUP_DIR/storage`      |
| `restore-postgres.sh` | `pg_restore` a dump into a target database           |
| `restore-storage.sh`  | `mc mirror` a backup back into a bucket              |

All scripts are `set -euo pipefail`, print what they do, and never echo
credentials. Make them executable once: `chmod +x infrastructure/backup/*.sh`
(git preserves the bit afterwards).

## Quick start (local)

```bash
export DATABASE_URL=postgres://yourcrm:yourcrm_dev@localhost:5442/yourcrm
export BACKUP_DIR=/var/backups/yourcrm   # or ./backups for a trial run

./infrastructure/backup/backup-postgres.sh
./infrastructure/backup/backup-storage.sh
```

## Verify a backup (do this before you need it)

```bash
# Postgres: restore into a scratch database and compare table counts.
./infrastructure/backup/restore-postgres.sh \
  /var/backups/yourcrm/postgres/yourcrm-<stamp>.dump \
  postgres://yourcrm:yourcrm_dev@localhost:5442/yourcrm_restore_test

# Storage: restore into a scratch bucket and diff the object count.
./infrastructure/backup/restore-storage.sh \
  /var/backups/yourcrm/storage/yourcrm yourcrm_restore_test
```

## Scheduling

Cron (daily 02:00) or a systemd timer; one line per script with `BACKUP_DIR`
and `DATABASE_URL` exported. Keep an off-site copy of `$BACKUP_DIR`
(rsync/rclone to a second location) — a backup on the same disk as the
database is a copy, not a backup.

## Retention & encryption

- `RETENTION_DAYS` (default 14) prunes Postgres dumps; storage mirrors are
  full copies — prune dated snapshots at the filesystem/snapshot layer.
- Set `GPG_RECIPIENT` to GPG-encrypt Postgres dumps at rest; restores
  decrypt transparently. Bucket contents inherit the bucket's SSE settings;
  enabling MinIO/S3 server-side encryption is recommended.
