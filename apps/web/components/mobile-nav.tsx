"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Dialog, cn } from "@yourcrm/ui"
import { NAV_SECTIONS } from "./nav-sections"
import { NavIcon } from "./nav-icons"

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
        className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-card/95 backdrop-blur pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {CORE_ITEMS.map((item) => {
          const active = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] transition-colors",
                active ? "font-semibold text-primary" : "text-muted-foreground",
              )}
            >
              <NavIcon href={item.href} className="h-5 w-5" />
              {item.label}
            </Link>
          )
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] text-muted-foreground"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <circle cx="5" cy="12" r="1.4" />
            <circle cx="12" cy="12" r="1.4" />
            <circle cx="19" cy="12" r="1.4" />
          </svg>
          More
        </button>
      </nav>

      <Dialog
        open={moreOpen}
        onOpenChange={setMoreOpen}
        title="All modules"
        className="max-h-[80vh] overflow-y-auto"
      >
        <nav aria-label="All modules" className="flex flex-col gap-4">
          {NAV_SECTIONS.map((section) => (
            <div key={section.group}>
              <p className="px-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.group}
              </p>
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => {
                  const active = pathname === item.href
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setMoreOpen(false)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-accent",
                          active && "bg-accent font-medium",
                        )}
                      >
                        <NavIcon
                          href={item.href}
                          className="h-[18px] w-[18px] text-muted-foreground"
                        />
                        {item.label}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>
      </Dialog>
    </>
  )
}
