"use client"

import { Suspense, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Skeleton } from "@yourcrm/ui"
import { exchangePortalToken } from "../portal-client"

/**
 * Magic-link landing page: `/portal/verify?token=…`.
 *
 * The token travels in the URL exactly once and is exchanged immediately for
 * an httpOnly cookie, then replaced in history so it does not linger in the
 * address bar or in a shared screenshot. The exchange is single-use
 * server-side, so a link that is opened twice (a prefetching mail client,
 * a second tab) fails closed with the same message as an expired one.
 */
function VerifyPortalToken() {
  const router = useRouter()
  const params = useSearchParams()
  const token = params?.get("token") ?? ""
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (token === "") {
      setFailed(true)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    void exchangePortalToken(token, controller.signal)
      .then(() => {
        if (cancelled) return
        // Drop the token from the URL before navigating on.
        window.history.replaceState(null, "", "/portal/verify")
        router.replace("/portal")
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [router, token])

  if (failed) {
    return (
      <div className="flex flex-col gap-3" role="alert">
        <h1 className="text-xl font-semibold">This link no longer works</h1>
        <p className="text-sm text-muted-foreground">
          Sign-in links can only be used once and expire after 15 minutes.
        </p>
        <Link href="/portal/login" className="text-sm underline">
          Request a new link
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <h1 className="text-xl font-semibold">Signing you in…</h1>
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-4 w-32" />
    </div>
  )
}

export default function PortalVerifyPage() {
  return (
    <Suspense fallback={<Skeleton className="h-6 w-40" />}>
      <VerifyPortalToken />
    </Suspense>
  )
}
