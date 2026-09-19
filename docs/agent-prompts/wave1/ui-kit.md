# Wave 1 — Design System Agent (`packages/ui`)

Branch: `agent/ui-kit`

You build the shared UI primitives that **eleven** later module agents will
import. If you do not build a primitive, eleven agents will each invent their
own incompatible version. Your output is the most reused code in the project.

Spec: `docs/yourcrm-agent-spec-pack/02-design-system.md`

## You own, exclusively

```text
packages/ui/**
```

Nothing else. Not `apps/web`, not `packages/crm`, not the database.

## Build these, in this order

1. `cn` / tokens — already present, keep the existing `utils.ts` and `button.tsx`
2. **States** — `Skeleton`, `EmptyState` (icon, title, description, action),
   `ErrorState` (message + retry callback)
3. **DataTable** — generic over row type:
   - configurable + reorderable columns, per-column visibility
   - sort by column, controlled pagination (cursor in / cursor out)
   - row selection with a header checkbox and indeterminate state
   - `loading` renders `Skeleton` rows preserving column layout
   - `empty` renders `EmptyState`
   - optional inline cell edit via a `renderEdit` prop
4. **FilterBuilder** — AND/OR groups, nestable one level, field + operator +
   value; emits a serializable filter tree. Define and export that tree type —
   the API agents will encode it in query strings.
5. **BulkBar** — appears on selection; slot for actions, shows selected count
6. **SavedViews** — named view chips, create/rename/delete, active state
7. **RecordHeader** — title, subtitle, status badge, owner, action slot
8. **Timeline** — ordered items with icon, actor, timestamp, body slot
9. **Form fields** — `Field` wrapper (label, hint, error), `TextField`,
   `TextArea`, `Select`, `Checkbox`, `DatePicker`, `Combobox`
10. **Dialog / ConfirmDialog**, **Badge**, **Avatar**, **Tabs**, **Toast**

## Rules

- shadcn/ui conventions, Tailwind, Radix primitives where already installed.
  **Check what is installed before designing an API around it** — you may not
  add dependencies. If a Radix package you want is absent, build it with
  plain React + Tailwind instead, and note it in your report.
- Every component is controlled, accepts `className`, forwards refs where it
  wraps a DOM node.
- Keyboard accessible: the product principle is keyboard-first. Tables support
  arrow navigation, dialogs trap focus and close on Escape.
- Light and dark must both work via the existing token setup.
- No data fetching, no TanStack Query, no Zustand, no API types. Pure
  presentation. Props in, callbacks out.
- Export everything from `packages/ui/src/index.ts`.
- A `*.test.tsx` per component covering render + the primary interaction.

## Deliverable contract

Downstream agents will write, verbatim:

```tsx
import { DataTable, FilterBuilder, BulkBar, EmptyState, Skeleton, ErrorState,
         RecordHeader, Timeline, Field, TextField, ConfirmDialog } from "@yourcrm/ui"
```

Every one of those must exist and be usable without a wrapper. End your report
with the exact prop signature of `DataTable`, `FilterBuilder` and `RecordHeader`
so the module agents can code against them.
