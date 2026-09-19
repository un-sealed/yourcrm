# Coding Agent Prompt Template

You are implementing one YourCRM module from its specification.

## Rules

1. Read the assigned module completely.
2. Read its dependencies from `AGENT-DEPENDENCIES.md`.
3. Inspect existing shared contracts before adding code.
4. Do not create duplicate auth, permissions, UI primitives or API conventions.
5. Implement P0 first, then P1, then P2.
6. Add migrations safely and make them reversible where practical.
7. Add domain events for important writes.
8. Add unit, API/integration and Playwright coverage.
9. Enforce permissions server-side.
10. Add loading, empty and error states.
11. Make the primary workflow mobile usable.
12. Do not invent features outside the module unless required by a dependency.
13. If a shared contract is missing, document the gap instead of silently creating an incompatible alternative.

## Completion checklist

- [ ] UI routes implemented
- [ ] API implemented
- [ ] DB changes/migrations implemented
- [ ] Permissions enforced
- [ ] Events emitted
- [ ] Search/filter/bulk behavior
- [ ] Audit behavior
- [ ] Loading/empty/error states
- [ ] Mobile behavior
- [ ] Tests
- [ ] Seed/example data where useful
- [ ] Developer documentation
