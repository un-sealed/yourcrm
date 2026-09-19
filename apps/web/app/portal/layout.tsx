import type { Metadata } from "next"
import { PortalShell } from "./portal-shell"

/**
 * Customer portal layout (spec 45-customer-portal, P0).
 *
 * The portal is PUBLIC in the routing sense: unlike `/app/*`, this layout
 * does NOT call `requireSessionUser()`, because its visitors are customers
 * and have no member session. Access control lives entirely in the API:
 * every `/api/v1/portal/*` call resolves the portal cookie server-side and
 * answers 401 or 404. Nothing on these pages is a security boundary.
 */
export const metadata: Metadata = {
  title: "Customer portal",
  description: "Your tickets, quotes and invoices",
  robots: { index: false, follow: false },
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell>{children}</PortalShell>
}
