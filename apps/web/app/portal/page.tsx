"use client"

import Link from "next/link"
import { EmptyState, ErrorState, Skeleton } from "@yourcrm/ui"
import { fetchPortalIdentity, type PortalIdentity } from "./portal-client"
import { usePortalResource } from "./use-portal-resource"

/**
 * Portal overview.
 *
 * Shows only what the signed-in identity is entitled to: the API returns the
 * entitlements resolved from its live access grants, and a section the
 * customer has no grant for is not linked at all. That is presentation, not
 * protection — the API answers 404 for anything out of scope regardless of
 * what this page renders.
 */

const SECTIONS = [
  {
    key: "tickets",
    href: "/portal/tickets",
    title: "Support tickets",
    description: "Track the requests you have raised and read our replies.",
  },
  {
    key: "invoices",
    href: "/portal/invoices",
    title: "Invoices",
    description: "See what has been billed, what is paid and what is outstanding.",
  },
  {
    key: "quotes",
    href: "/portal/quotes",
    title: "Quotes",
    description: "Review the quotes we have sent you.",
  },
] as const

export default function PortalOverviewPage() {
  const { data, error, loading, reload } = usePortalResource<PortalIdentity>(
    (signal) => fetchPortalIdentity(signal),
    [],
  )

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading your portal">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error) return <ErrorState message={error} onRetry={reload} />
  if (!data) return <EmptyState title="Nothing to show yet." />

  const available = SECTIONS.filter((section) => data.entitlements[section.key])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">
          Welcome{data.displayName ? `, ${data.displayName}` : ""}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Signed in as {data.email}</p>
      </div>

      {available.length === 0 ? (
        <EmptyState
          title="Nothing has been shared with you yet"
          description="When we share a ticket, quote or invoice with you it will appear here."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {available.map((section) => (
            <Link
              key={section.key}
              href={section.href}
              className="rounded-lg border p-4 transition-colors hover:bg-secondary/50"
            >
              <p className="font-medium">{section.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
