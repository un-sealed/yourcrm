# infrastructure

- `docker/` — local development lives in the root `docker-compose.yml`
  (PostgreSQL + pgvector, Redis, MinIO). No other local infra required.
- Kubernetes (`k8s/`) and Terraform (`terraform/`) are **explicitly out of
  scope for Phase 0** (project restriction: no K8s as a development
  requirement). Production deployment targets land with the CI/CD agent in
  Phase 0b / Phase 1; the root `Dockerfile` already builds the API image.
