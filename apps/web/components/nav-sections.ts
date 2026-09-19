export type NavItem = { href: string; label: string }
export type NavSection = { group: string; items: NavItem[] }

export const NAV_SECTIONS: NavSection[] = [
  {
    group: "Sales",
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
    group: "Engage",
    items: [
      { href: "/app/inbox", label: "Inbox" },
      { href: "/app/email", label: "Email" },
      { href: "/app/whatsapp", label: "WhatsApp" },
      { href: "/app/calling", label: "Calling" },
    ],
  },
  {
    group: "Business",
    items: [
      { href: "/app/products", label: "Products" },
      { href: "/app/quotes", label: "Quotes" },
      { href: "/app/invoices", label: "Invoices" },
      { href: "/app/tickets", label: "Tickets" },
      { href: "/app/knowledge-base", label: "Knowledge Base" },
      { href: "/app/forms", label: "Forms" },
    ],
  },
  {
    group: "Platform",
    items: [
      { href: "/app/automation", label: "Automation" },
      { href: "/app/reports", label: "Reports" },
      { href: "/app/analytics", label: "Analytics" },
      { href: "/app/search", label: "Search" },
      { href: "/app/import-export", label: "Import / Export" },
      { href: "/app/integrations", label: "Integrations" },
      { href: "/app/ai", label: "AI Assistant" },
      { href: "/app/settings", label: "Settings" },
    ],
  },
]

export const ALL_ROUTES: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items)
