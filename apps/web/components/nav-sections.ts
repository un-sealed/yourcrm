export type NavItem = { href: string; label: string; count?: number }
export type NavSection = { group: string; items: NavItem[] }

/**
 * Sidebar groups per docs/design/DASHBOARD-REDESIGN.md §2: uppercase 11px
 * `--text-muted` section labels (GENERAL, TOOLS, SUPPORT), rendered by
 * `app-shell.tsx`. `count` is optional — when present the sidebar renders a
 * right-aligned pill badge; no route currently reports a live count, so no
 * badge renders until a data source is wired (see report).
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    group: "General",
    items: [
      { href: "/app/dashboard", label: "Dashboard" },
      { href: "/app/people", label: "People" },
      { href: "/app/companies", label: "Companies" },
      { href: "/app/leads", label: "Leads" },
      { href: "/app/deals", label: "Deals" },
      { href: "/app/activities", label: "Activities" },
      { href: "/app/tasks", label: "Tasks" },
      { href: "/app/calendar", label: "Calendar" },
    ],
  },
  {
    group: "Tools",
    items: [
      { href: "/app/inbox", label: "Inbox" },
      { href: "/app/email", label: "Email" },
      { href: "/app/whatsapp", label: "WhatsApp" },
      { href: "/app/calling", label: "Calling" },
      { href: "/app/products", label: "Products" },
      { href: "/app/quotes", label: "Quotes" },
      { href: "/app/invoices", label: "Invoices" },
      { href: "/app/forms", label: "Forms" },
      { href: "/app/automation", label: "Automation" },
      { href: "/app/reports", label: "Reports" },
      { href: "/app/analytics", label: "Analytics" },
      { href: "/app/search", label: "Search" },
      { href: "/app/import-export", label: "Import / Export" },
      { href: "/app/integrations", label: "Integrations" },
      { href: "/app/custom-objects", label: "Custom Objects" },
      { href: "/app/ai", label: "AI Assistant" },
    ],
  },
  {
    group: "Support",
    items: [
      { href: "/app/tickets", label: "Tickets" },
      { href: "/app/knowledge-base", label: "Knowledge Base" },
      { href: "/app/settings", label: "Settings" },
      { href: "/app/settings/onboarding", label: "Onboarding" },
    ],
  },
]

export const ALL_ROUTES: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items)
