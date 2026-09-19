# `@yourcrm/ui`

Shared design-token + primitive layer (shadcn/ui conventions, Tailwind).
Pure presentation: props in, callbacks out. No data fetching, no stores
(except the tiny `toastStore`), no API types. App code must import from
`@yourcrm/ui` — never duplicate primitives per app.

## Constraints (Wave-1 UI kit)

- No new dependencies were added: only `react`, `class-variance-authority`,
  `clsx`, `tailwind-merge`. **No Radix package is installed**, so Dialog,
  Select, DatePicker, Combobox and Tabs are built with plain React +
  Tailwind (native inputs/selects, focus management by hand). If a later
  agent wants Radix behavior, it must stay API-compatible with these props.
- Every component is controlled (with uncontrolled fallbacks where a bare
  `rows` + `columns` render must just work), accepts `className`, and
  forwards refs where it wraps a DOM node.
- Keyboard-first: tables support arrow-key cell navigation, dialogs trap
  focus and close on Escape, tabs use roving tabindex + arrows.
- Light/dark via the existing token setup (`bg-background`, `bg-muted`,
  `bg-primary`, … plus `dark:` overrides where raw palette colors are used).
- Tests run under `bun test` with no DOM library (none is installed and
  agents may not add dependencies): hook-free components are asserted
  through `src/test-helpers.tsx` (static element-tree renderer), stateful
  components through exported pure helpers (`nextSortDirection`,
  `toggleRowSelected`, `encodeFilterTree`, `filterComboboxOptions`,
  `toastStore`, …) plus element-validity smoke tests.

## Exports

- Foundations: `cn`, `Button` (+ `buttonVariants`), `Skeleton`,
  `EmptyState`, `ErrorState`, `Badge` (+ tones), `Avatar` (+ `getInitials`)
- Data: `DataTable` (+ selection/sort/order/visibility helpers),
  `FilterBuilder` (+ `FilterTree` types and `encodeFilterTree` /
  `decodeFilterTree` query-string codec), `BulkBar`, `SavedViews`
- Record: `RecordHeader`, `Timeline`
- Forms: `Field`, `TextField`, `TextArea`, `Select`, `Checkbox`,
  `DatePicker`, `Combobox` (+ `filterComboboxOptions`)
- Overlays/feedback: `Dialog`, `ConfirmDialog`, `Tabs`, `Toaster` /
  `StoreToaster` (+ `toast`, `toastStore`)

## Filter query-string contract

API agents persist `FilterTree` values as `?filter=<encodeFilterTree(tree)>`
(base64url JSON) and restore them with `decodeFilterTree` (throws on
invalid input).
