# Dashboard redesign — the single source of truth

Every agent working on this redesign builds against THIS FILE. Do not invent
colours, radii, shadows or spacing. If something is missing here, say so in
your report rather than guessing — a second invented value is how a design
system dies.

Target: light, airy, modern SaaS analytics. White cards on a soft tinted page,
generous whitespace, thin recessive gridlines, one blue accent doing the work.
The current "midnight glass" dark/aurora/gradient theme is being **replaced**.

---

## 1. Tokens

Declared once in `apps/web/app/globals.css` as CSS custom properties, consumed
through Tailwind. **Never hardcode a hex in a component.**

### Surfaces & ink (light — the default)
```
--page:            #f4f5f7   /* app background behind cards */
--surface-1:       #ffffff   /* card background */
--surface-2:       #fafbfc   /* nested/inset panels, table header row */
--border:          #e8eaed   /* 1px card and divider border */
--border-strong:   #d6d9de   /* input borders, focus outline base */
--text-primary:    #12141a
--text-secondary:  #5b6472
--text-muted:      #8b93a1   /* axis labels, captions, "vs. last period" */
```

### Surfaces & ink (dark — selected, not an auto-flip)
```
--page:            #0e1013
--surface-1:       #14161a
--surface-2:       #1a1d22
--border:          #24282f
--border-strong:   #333842
--text-primary:    #f2f4f7
--text-secondary:  #a8b0bd
--text-muted:      #6f7885
```

### Brand & status
```
--brand:           #2563eb   /* primary buttons, active nav, key series   */
--brand-hover:     #1d4ed8
--brand-soft:      #eff4ff   /* active nav pill bg (light)                */
--brand-soft-dark: #17203a   /* active nav pill bg (dark)                 */

--good:            #16a34a   /* positive delta                            */
--good-soft:       #e8f7ee
--bad:             #dc2626   /* negative delta                            */
--bad-soft:        #fdeced
--warn:            #d97706
```
Status colours are reserved. **Never reuse them as a chart series colour.**

### Categorical series — fixed order, never cycled
Validated with the dataviz validator; both modes pass every hard gate.

| Slot | Light | Dark |
|---|---|---|
| 1 | `#2563eb` | `#3b82f6` |
| 2 | `#f97316` | `#d1720f` |
| 3 | `#14b8a6` | `#0d9488` |
| 4 | `#7c3aed` | `#8b5cf6` |
| 5 | `#e11d48` | `#f43f5e` |

Rules that are not negotiable:
- Assign slots **in order**. A 6th series folds into "Other" — never a new hue.
- Colour follows the **entity**, never its rank. Filtering out a series must
  not repaint the survivors.
- Slots 2 and 3 sit below 3:1 contrast on white: any chart using them **must**
  carry visible direct labels or a table view. This is not optional.
- Text always wears text tokens, never the series colour.

### Radius, shadow, spacing
```
--radius-card:  14px
--radius-ctl:   10px   /* buttons, inputs, pills */
--radius-pill:  999px  /* badges, delta chips */

--shadow-card:  0 1px 2px rgb(16 24 40 / 0.04), 0 1px 3px rgb(16 24 40 / 0.06)
--shadow-pop:   0 8px 24px rgb(16 24 40 / 0.10), 0 2px 6px rgb(16 24 40 / 0.06)
```
Card padding 20px. Grid gap 16px. Section gap 24px.
Cards are the ONLY grouping primitive — no nested card-in-card borders.

---

## 2. Layout

```
┌──────────┬────────────────────────────────────────────┐
│ sidebar  │ topbar                                     │
│ 248px    ├────────────────────────────────────────────┤
│ fixed    │ page title + date range + actions          │
│          │ ┌────┬────┬────┬────┐  KPI row (4 across)  │
│          │ └────┴────┴────┴────┘                      │
│          │ ┌───────────────┬──────────┐               │
│          │ │ main col 2fr  │ side 1fr │               │
│          │ └───────────────┴──────────┘               │
└──────────┴────────────────────────────────────────────┘
```
- Sidebar `248px`, `--surface-1`, 1px right border. Collapses below `md`.
- Content max-width `1440px`, page padding `24px`.
- Main/side split `minmax(0,2fr) minmax(0,1fr)`, gap 16px. Stacks below `lg`.

### Sidebar
- Brand row: logo + collapse toggle.
- Grouped nav with **uppercase 11px `--text-muted` section labels** (`GENERAL`,
  `TOOLS`, `SUPPORT`) — matches the reference.
- Item: 36px tall, `--radius-ctl`, 12px gap icon→label, 14px label.
  - default `--text-secondary`, hover `--surface-2`
  - **active**: `--brand-soft` background, `--brand` text/icon, 500 weight
- Count badges right-aligned, pill, `--surface-2` bg, 12px.
- Bottom: "Upgrade to Premium" card — `--brand` → `#1e40af` gradient, white
  text, `--radius-card`, white pill button. This is the ONE gradient allowed.

### Topbar
56px, `--surface-1`, bottom border. Search input (max 420px, `--surface-2`
fill, magnifier icon, `⌘K` hint chip right). Right cluster: theme toggle,
notification bell with dot, avatar.

---

## 3. Components to build

### StatTile (KPI)
White card. Label (13px `--text-secondary`) + outline icon top-right in
`--text-muted`. Value **30px/600 `--text-primary`, tabular-nums**. Delta pill
beside it: `--good`/`--good-soft` with ▲, `--bad`/`--bad-soft` with ▼, 12px,
`--radius-pill`. Caption below: `vs. 14,653 last period`, 12px `--text-muted`.
A bare stat tile has **no hover layer** — nothing to hover.

### AreaChart (Total Profit)
- 2px line, series-1. Fill = same hue vertical gradient 18% → 0%.
- Comparison series: 1.5px **dashed**, `--text-muted`, no fill.
- Y axis 3–4 ticks, abbreviated (`5K`, `10K`). X axis dates.
- Gridlines: horizontal only, 1px `--border`. **No vertical gridlines.**
- Axis/label text `--text-muted` 11px. No axis lines.
- **Hover is mandatory**: vertical crosshair + tooltip card (`--shadow-pop`)
  showing date, this-period and last-period values with a colour swatch each.
  Hit target spans the full plot height.
- Two series ⇒ a legend is required. Direct-label the current series end.

### BarChart (Most Day Active)
Single series, one highlighted bar. Highlighted = `--brand`; the rest
`--border-strong` (light) / `--surface-2` (dark) — a *de-emphasis*, not a
second series, so no legend. 4px top-rounded, anchored to the baseline. 2px gap
between bars. Value label above the highlighted bar only. Per-bar hover
tooltip.

### RadialGauge (Repeat Customer Rate)
270° arc, tick-mark style (~60 discrete ticks, 2px wide, 2px gap) as in the
reference. Filled ticks `--good`, remainder `--border`. Centre: value
**32px/600**, caption below in `--text-muted`. Single value ⇒ no legend.

### DataTable restyle
Header row `--surface-2`, 11px uppercase `--text-muted`, no heavy rule. Rows
52px, 1px `--border` separator, hover `--surface-2`. Numerics tabular-nums,
right-aligned. Rating = star glyph + value. Revenue keeps status colour but
**must** carry its ▲/▼ glyph — never colour alone.

### Widget picker modal
From the reference: title + close, scrollable list of widget cards. Each row =
thumbnail preview (left, `--surface-2`, `--radius-ctl`), title + description,
a `#Tag` pill, and a `Select` button (`--brand`, pill). `--shadow-pop`,
`--radius-card`, max-width 520px.

---

## 4. Hard rules

- **No dual-axis charts, ever.** Two measures of different scale ⇒ two charts.
- **Sequential = one hue light→dark. Diverging = two hues + neutral grey mid.**
  Never a rainbow.
- Thin marks, recessive grid, selective direct labels — never a number on
  every point.
- Every chart with ≥2 series ships a legend; ≤4 series are also direct-labelled.
- Dark mode is **selected** (the table above), not a CSS filter flip.
- All chart components accept `className` and render into the parent's width
  (`ResponsiveContainer` or a viewBox-based SVG). No fixed pixel widths.
- Keyboard: nav, tabs, dialogs and controls stay operable; dialogs trap focus
  and close on Escape. The product principle is keyboard-first.
- Currency/large numbers use `tabular-nums` so columns align.
