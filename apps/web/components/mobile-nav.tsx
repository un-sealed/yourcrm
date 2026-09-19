"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Dialog, cn } from "@yourcrm/ui"
import { NAV_SECTIONS } from "./nav-sections"

const CORE_ITEMS = [
  { href: "/app/dashboard", label: "Home" },
  { href: "/app/people", label: "People" },
  { href: "/app/deals", label: "Deals" },
  { href: "/app/tasks", label: "Tasks" },
]

/**
 * Bottom tab bar for small screens (`md:hidden`, mirrors the desktop
 * `<aside>` sidebar hidden at the same breakpoint in app-shell.tsx). Holds
 * the highest-frequency modules plus a "More" action that opens the full
 * `NAV_SECTIONS` list in the shared `Dialog` primitive — reusing it rather
 * than building a parallel Drawer/Sheet component that doesn't exist yet
 * in `@yourcrm/ui`.
 */
export function MobileNav() {
  const pathname = usePathname()
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {CORE_ITEMS.map((item) => {
          const active = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px]",
                active ? "font-semibold text-primary" : "text-muted-foreground",
              )}
            >
              {item.label}
            </Link>
          )
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] text-muted-foreground"
        >
          More
        </button>
      </nav>

      <Dialog
        open={moreOpen}
        onOpenChange={setMoreOpen}
        title="Menu"
        className="max-h-[80vh] overflow-y-auto"
      >
        <nav aria-label="All modules" className="flex flex-col gap-4">
          {NAV_SECTIONS.map((section) => (
            <div key={section.group}>
              <p className="px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {section.group}
              </p>
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    "block rounded-md px-2 py-2 text-sm hover:bg-accent",
                    pathname === item.href && "bg-accent font-medium",
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </Dialog>
    </>
  )
}
