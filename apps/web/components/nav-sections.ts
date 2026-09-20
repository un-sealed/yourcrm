export type NavItem = { href: string; label: string; count?: number }

export type NavSection = { id: string; label: string; items: NavItem[] }

/**
 * Navigation, as one column of short groups.
 *
 * The split is by task rather than by schema. The original three groups
 * (General 8, Tools 16, Support 4) put more than half the product under
 * "Tools", a heading that means "everything that is not a record type" —
 * a statement about the data model rather than about anyone's job, and a
 * list nobody can scan.
 *
 * These groups are sized to be read at a glance: who you sell to
 * (Customers), what you sell them (Sales), how you talk to them (Inbox),
 * what runs by itself (Automate), what it all adds up to (Insights). The
 * largest is five.
 *
 * `count` is optional — when present the sidebar renders a right-aligned
 * badge. No route reports a live count yet, so no badge renders until a
 * data source is wired.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    id: "workspace",
    label: "Workspace",
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
    items: [
      { href: "/app/people", label: "People" },
      { href: "/app/companies", label: "Companies" },
      { href: "/app/leads", label: "Leads" },
    ],
  },
  {
    id: "sales",
    label: "Sales",
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
    items: [
      { href: "/app/reports", label: "Reports" },
      { href: "/app/analytics", label: "Analytics" },
      { href: "/app/search", label: "Search" },
      { href: "/app/ai", label: "AI Assistant" },
    ],
  },
  {
    id: "admin",
    label: "Support & settings",
    items: [
      { href: "/app/tickets", label: "Tickets" },
      { href: "/app/knowledge-base", label: "Knowledge Base" },
      { href: "/app/settings", label: "Settings" },
      { href: "/app/settings/onboarding", label: "Onboarding" },
    ],
  },
]

/** Every route, for the command palette. Must stay exhaustive. */
export const ALL_ROUTES: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items)
