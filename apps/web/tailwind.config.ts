import type { Config } from "tailwindcss"

/**
 * Tailwind theme keys map 1:1 onto the spec tokens in `app/globals.css`
 * (docs/design/DASHBOARD-REDESIGN.md §1). Every color value is a
 * `var(--…)` reference — no hex lives here or in any component.
 *
 * The legacy shadcn-style keys (`background`, `card`, `muted`, `accent`,
 * `popover`, …) are kept as aliases onto the same tokens so components
 * outside this redesign's scope keep rendering while sibling agents
 * restyle their pages.
 */
const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Spec §1 — surfaces & ink.
        page: "var(--page)",
        surface: { 1: "var(--surface-1)", 2: "var(--surface-2)" },
        ink: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          muted: "var(--text-muted)",
        },
        border: { DEFAULT: "var(--border)", strong: "var(--border-strong)" },
        // The navigation slab's own scale. Deliberately NOT an alias onto
        // `surface`/`ink`: the sidebar is a dark material in both themes, so
        // it cannot inherit tokens that flip with the theme.
        nav: {
          DEFAULT: "var(--nav-bg)",
          hover: "var(--nav-hover)",
          active: "var(--nav-active)",
          border: "var(--nav-border)",
          ink: "var(--nav-ink)",
          "ink-2": "var(--nav-ink-2)",
          "ink-muted": "var(--nav-ink-muted)",
          brand: "var(--nav-brand)",
        },
        // Spec §1 — brand & status.
        brand: {
          DEFAULT: "var(--brand)",
          hover: "var(--brand-hover)",
          soft: "var(--brand-soft)",
          deep: "var(--brand-deep)",
        },
        good: { DEFAULT: "var(--good)", soft: "var(--good-soft)" },
        bad: { DEFAULT: "var(--bad)", soft: "var(--bad-soft)" },
        warn: "var(--warn)",
        // Spec §1 — categorical series, fixed slot order.
        series: {
          1: "var(--series-1)",
          2: "var(--series-2)",
          3: "var(--series-3)",
          4: "var(--series-4)",
          5: "var(--series-5)",
        },
        // Legacy aliases onto the spec tokens (see doc comment above).
        background: "var(--page)",
        foreground: "var(--text-primary)",
        primary: { DEFAULT: "var(--brand)", foreground: "var(--surface-1)" },
        secondary: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--text-primary)",
        },
        muted: { DEFAULT: "var(--surface-2)", foreground: "var(--text-muted)" },
        accent: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--text-secondary)",
        },
        destructive: {
          DEFAULT: "var(--bad)",
          foreground: "var(--surface-1)",
        },
        success: { DEFAULT: "var(--good)", foreground: "var(--surface-1)" },
        warning: { DEFAULT: "var(--warn)", foreground: "var(--surface-1)" },
        card: { DEFAULT: "var(--surface-1)", foreground: "var(--text-primary)" },
        popover: {
          DEFAULT: "var(--surface-1)",
          foreground: "var(--text-primary)",
        },
        input: "var(--border-strong)",
        // Focus rings are `--border-strong` everywhere (spec §4 / hard rules),
        // including primitives from `@yourcrm/ui` that use `ring-ring`.
        ring: "var(--border-strong)",
        sidebar: {
          DEFAULT: "var(--surface-1)",
          foreground: "var(--text-secondary)",
          muted: "var(--text-muted)",
          accent: "var(--brand-soft)",
          "accent-foreground": "var(--brand)",
          border: "var(--border)",
        },
      },
      borderRadius: {
        card: "var(--radius-card)",
        ctl: "var(--radius-ctl)",
        pill: "var(--radius-pill)",
        md: "var(--radius-ctl)",
        lg: "var(--radius-card)",
        sm: "calc(var(--radius-ctl) - 4px)",
        xl: "var(--radius-card)",
      },
      boxShadow: {
        // NOTE: shadow keys must not match a `colors` key — Tailwind also
        // generates `shadow-<color>` utilities, and a shared name makes the
        // colour rule win over the shadow.
        xs: "0 1px 2px 0 rgb(15 23 42 / 0.05)",
        card: "var(--shadow-card)",
        panel: "var(--shadow-card)",
        pop: "var(--shadow-pop)",
      },
    },
  },
  plugins: [],
}

export default config
