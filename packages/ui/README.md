# `@yourcrm/ui`

Shared design-token + primitive layer (shadcn/ui conventions).

- `src/utils.ts` — `cn()` class merger.
- `src/button.tsx` — Button primitive + `buttonVariants`.
- Later agents add primitives here (dialog, dropdown, toast, …). App code
  must import from `@yourcrm/ui`, never duplicate primitives per app.
