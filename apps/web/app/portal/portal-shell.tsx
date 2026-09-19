"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Button } from "@yourcrm/ui"
import { logoutPortal } from "./portal-client"

/**
 * Customer portal chrome.
 *
 * Deliberately NOT the app shell: no workspace switcher, no member nav, no
 * `components/nav-sections.ts` entry (that file belongs to the CRM sidebar
 * and a customer must never appear in it). The portal is a separate, much
 * smaller surface reached at `/portal`.
 */

const LINKS = [
  { href: "/portal", label: "Overview" },
  { href: "/portal/tickets", label: "Tickets" },
  { href: "/portal/invoices", label: "Invoices" },
  { href: "/portal/quotes", label: "Quotes" },
] as const

/** Sign-in and link-verification pages render bare (no nav, no sign-out). */
function isAuthRoute(pathname: string): boolean {
  return pathname.startsWith("/portal/login") || pathname.startsWith("/portal/verify")
}

export function PortalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/portal"
  const router = useRouter()

  if (isAuthRoute(pathname)) {
    return <main className="mx-auto w-full max-w-md px-4 py-10 sm:py-16">{children}</main>
  }

  async function signOut(): Promise<void> {
    try {
      await logoutPortal()
    } finally {
      router.push("/portal/login")
      router.refresh()
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/portal" className="text-base font-semibold">
            Customer portal
          </Link>
          <div className="flex items-center justify-between gap-2">
            {/* Horizontal scroll rather than a hamburger: four links fit on a
                phone, and a disclosure menu would hide the whole portal. */}
            <nav aria-label="Portal" className="-mx-1 flex gap-1 overflow-x-auto">
              {LINKS.map((link) => {
                const active =
                  link.href === "/portal" ? pathname === "/portal" : pathname.startsWith(link.href)
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-md px-3 py-1.5 text-sm ${
                      active
                        ? "bg-secondary font-medium text-secondary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {link.label}
                  </Link>
                )
              })}
            </nav>
            <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl px-4 py-6">{children}</main>
    </div>
  )
}
