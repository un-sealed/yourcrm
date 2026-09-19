# `@yourcrm/permissions`

Workspace -> object -> record -> field -> action policy foundation.

Domain agents: call `requirePermission()` server-side in every service
method. Add narrower object/record rules inside domain services; do not
replace this package with ad-hoc checks.
