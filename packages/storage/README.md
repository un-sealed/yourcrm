# `@yourcrm/storage`

S3-compatible storage abstraction (MinIO locally, S3 in production).

- Never store binary bytes in PostgreSQL — metadata in DB, bytes here.
- `StorageService` wraps put/get/remove/presigned URLs.
