"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@yourcrm/ui"
import { apiFetchRaw } from "@/lib/api-client"
import { getClientEnv } from "@/lib/env"

type MeResponse = { data: { user: { email: string; name?: string | null } } }

/**
 * Shows who is actually signed in, and lets them sign out. Replaces a
 * hardcoded "Dev User" placeholder that made it impossible to tell whether
 * login had worked.
 */
export function SessionFooter() {
  const router = useRouter()
  const [label, setLabel] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    let active = true
    apiFetchRaw<MeResponse>("/api/v1/auth/me")
      .then((res) => {
        if (!active) return
        setLabel(res.data.user.name ?? res.data.user.email)
      })
      .catch(() => {
        if (active) setLabel(null)
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

  if (!checked) return <p>Loading session…</p>
  if (!label)
    return (
      <p>
        Not signed in ·{" "}
        <a className="underline" href="/login">
          Log in
        </a>
      </p>
    )

  return (
    <div className="flex items-center justify-between gap-2">
      <p className="truncate">{label}</p>
      <Button variant="ghost" size="sm" onClick={signOut}>
        Sign out
      </Button>
    </div>
  )
}
