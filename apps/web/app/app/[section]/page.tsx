import { notFound } from "next/navigation"
import { ModulePlaceholder } from "@/components/module-placeholder"

/**
 * Future-module catch-all. Every shell route from spec 00 renders a
 * placeholder until its module agent ships a concrete `page.tsx`
 * (concrete pages take precedence over this dynamic route automatically).
 */
const TITLES: Record<string, { title: string; spec: string }> = {
  people: { title: "People", spec: "06-people" },
  companies: { title: "Companies", spec: "07-companies" },
  leads: { title: "Leads", spec: "08-leads" },
  deals: { title: "Deals", spec: "09-deals" },
  activities: { title: "Activities", spec: "11-activities" },
  tasks: { title: "Tasks", spec: "12-tasks" },
  calendar: { title: "Calendar", spec: "13-calendar" },
  inbox: { title: "Unified Inbox", spec: "15-unified-inbox" },
  email: { title: "Email", spec: "14-email" },
  whatsapp: { title: "WhatsApp", spec: "16-whatsapp" },
  calling: { title: "Calling", spec: "17-calling" },
  products: { title: "Products", spec: "18-products" },
  quotes: { title: "Quotes", spec: "19-quotes" },
  invoices: { title: "Invoices", spec: "20-invoices-payments" },
  tickets: { title: "Tickets", spec: "21-support" },
  "knowledge-base": { title: "Knowledge Base", spec: "22-knowledge-base" },
  forms: { title: "Forms", spec: "23-forms" },
  automation: { title: "Automation", spec: "25-automation" },
  reports: { title: "Reports", spec: "26-reports" },
  analytics: { title: "Dashboards & Analytics", spec: "27-dashboards" },
  search: { title: "Search", spec: "28-search" },
  "import-export": { title: "Import / Export", spec: "30-import-export" },
  integrations: { title: "Integrations", spec: "31-integrations" },
  ai: { title: "AI Assistant", spec: "34-ai-assistant" },
  settings: { title: "Settings", spec: "40-settings-security-compliance" },
}

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params
  const entry = TITLES[section]
  if (!entry) notFound()
  return <ModulePlaceholder title={entry.title} spec={entry.spec} />
}
