export type NavItem = { href: string; label: string; count?: number }

export type NavSection = {
  id: string
  label: string
  /**
   * Route whose glyph stands for the section on the rail. Reusing an item's
   * icon keeps one icon language instead of inventing a second set that has
   * to stay visually consistent with the first.
   */
  icon: string
  /** Pinned below the rail's spacer rather than in the main run. */
  placement?: "bottom"
  items: NavItem[]
}

/**
 * Navigation, grouped for a two-tier rail + panel sidebar.
 *
 * The rail shows one icon per section; the panel shows only that section's
 * items. That sets the constraint these groups are built to: **a section has
 * to fit a panel without scrolling.** The previous three groups (General 8,
 * Tools 16, Support 4) could not — sixteen entries under "Tools" was a
 * catch-all that meant "everything that is not a record type", which is a
 * statement about the schema rather than about anyone's job.
 *
 * So the split is by task instead: who you sell to (Customers), what you
 * sell them (Sales), how you talk to them (Inbox), what runs by itself
 * (Automate), what it all adds up to (Insights). Largest section is five.
 *
 * `count` is optional — when present the panel renders a right-aligned
 * badge. No route reports a live count yet, so no badge renders until a
 * data source is wired.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    id: "workspace",
    label: "Workspace",
    icon: "/app/dashboard",
    items: [
      { href: "/app/dashboard", label: "Dashboard" },
      { href: "/app/activities", label: "Activities" },
      { href: "/app/tasks", label: "Tasks" },
      { href: "/app/calendar", label: "Calendar" },
    ],
  },
  {
    id: "customers",
    label: "Customers",
    icon: "/app/people",
    items: [
      { href: "/app/people", label: "People" },
      { href: "/app/companies", label: "Companies" },
      { href: "/app/leads", label: "Leads" },
    ],
  },
  {
    id: "sales",
    label: "Sales",
    icon: "/app/deals",
    items: [
      { href: "/app/deals", label: "Deals" },
      { href: "/app/products", label: "Products" },
      { href: "/app/quotes", label: "Quotes" },
      { href: "/app/invoices", label: "Invoices" },
    ],
  },
  {
    id: "inbox",
    label: "Inbox",
    icon: "/app/inbox",
    items: [
      { href: "/app/inbox", label: "Inbox" },
      { href: "/app/email", label: "Email" },
      { href: "/app/whatsapp", label: "WhatsApp" },
      { href: "/app/calling", label: "Calling" },
    ],
  },
  {
    id: "automate",
    label: "Automate",
    icon: "/app/automation",
    items: [
      { href: "/app/forms", label: "Forms" },
      { href: "/app/automation", label: "Automation" },
      { href: "/app/integrations", label: "Integrations" },
      { href: "/app/import-export", label: "Import / Export" },
      { href: "/app/custom-objects", label: "Custom Objects" },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    icon: "/app/reports",
    items: [
      { href: "/app/reports", label: "Reports" },
      { href: "/app/analytics", label: "Analytics" },
      { href: "/app/search", label: "Search" },
      { href: "/app/ai", label: "AI Assistant" },
    ],
  },
  {
    id: "support",
    label: "Support",
    icon: "/app/tickets",
    placement: "bottom",
    items: [
      { href: "/app/tickets", label: "Tickets" },
      { href: "/app/knowledge-base", label: "Knowledge Base" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: "/app/settings",
    placement: "bottom",
    items: [
      { href: "/app/settings", label: "Settings" },
      { href: "/app/settings/onboarding", label: "Onboarding" },
    ],
  },
]

/** Every route, for the command palette. Must stay exhaustive. */
export const ALL_ROUTES: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items)
