"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { cn } from "@yourcrm/ui"
import { apiFetchRaw } from "@/lib/api-client"
import { getClientEnv } from "@/lib/env"

type MeResponse = { data: { user: { email: string; name?: string | null } } }

/**
 * Who is signed in, pinned to the bottom of the sidebar.
 *
 * Replaces the old text-only session footer, which put a full-size "Sign out"
 * button beside the name and left no room for the email — so the sidebar
 * showed you a name with no way to tell which account it belonged to.
 *
 * On the collapsed rail this degrades to the avatar alone; the name and email
 * move into its tooltip rather than being dropped.
 *
 * Wears the `nav-*` scale rather than `surface`/`ink`: it sits on the tinted
 * navigation panel, which is a step away from the page in both themes (see
 * sidebar.tsx). The avatar borrows the active-pill treatment — a raised white
 * disc with a hairline — so it reads as the anchor of the footer column.
 */
export function SidebarUser({ expanded }: { expanded: boolean }) {
  const router = useRouter()
  const [user, setUser] = useState<{ name: string; email: string } | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    let active = true
    apiFetchRaw<MeResponse>("/api/v1/auth/me")
      .then((res) => {
        if (!active) return
        setUser({ name: res.data.user.name ?? res.data.user.email, email: res.data.user.email })
      })
      .catch(() => {
        if (active) setUser(null)
      })
      .finally(() => {
        if (active) setChecked(true)
      })
    return () => {
      active = false
    }
  }, [])

  async function signOut() {
    const { NEXT_PUBLIC_API_URL } = getClientEnv()
    await fetch(`${NEXT_PUBLIC_API_URL}/api/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
    })
    router.push("/login")
    router.refresh()
  }

  if (!checked) {
    return (
      <div className={cn("flex h-9 items-center", expanded ? "gap-2.5 px-1" : "justify-center")}>
        <span className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-nav-hover" />
        {expanded ? <span className="h-3 w-24 animate-pulse rounded bg-nav-hover" /> : null}
      </div>
    )
  }

  if (user === null) {
    return expanded ? (
      <a
        href="/login"
        className="flex h-9 items-center rounded-ctl px-2.5 text-sm text-nav-ink-2 transition-colors hover:bg-nav-hover hover:text-nav-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
      >
        Not signed in — log in
      </a>
    ) : (
      <a
        href="/login"
        aria-label="Log in"
        title="Not signed in — log in"
        className="flex h-9 items-center justify-center rounded-ctl text-nav-ink-2 transition-colors hover:bg-nav-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-[18px] w-[18px]"
        >
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" />
        </svg>
      </a>
    )
  }

  const initial = user.name.charAt(0).toUpperCase()

  if (!expanded) {
    return (
      <div className="flex justify-center" title={`${user.name} · ${user.email}`}>
        <span
          role="img"
          aria-label={`Signed in as ${user.name}`}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-nav-active text-sm font-semibold text-nav-brand ring-1 ring-nav-border"
        >
          {initial}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2.5 rounded-ctl px-1 py-1">
      <span
        role="img"
        aria-label={`Signed in as ${user.name}`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-nav-active text-sm font-semibold text-nav-brand ring-1 ring-nav-border"
      >
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-nav-ink">{user.name}</p>
        <p className="truncate text-[11px] text-nav-ink-muted">{user.email}</p>
      </div>
      <button
        type="button"
        onClick={() => void signOut()}
        aria-label="Sign out"
        title="Sign out"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl text-nav-ink-muted transition-colors hover:bg-nav-hover hover:text-nav-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-4 w-4"
        >
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
        </svg>
      </button>
    </div>
  )
}
