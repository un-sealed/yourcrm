"use client"

import { Badge, EmptyState, ErrorState, Skeleton } from "@yourcrm/ui"
import {
  formatMoneyCents,
  formatPortalDate,
  listPortalQuotes,
  quoteTone,
  type PortalListResponse,
  type PortalQuote,
} from "../portal-client"
import { usePortalResource } from "../use-portal-resource"

/**
 * The customer's own quotes. Draft quotes are excluded by the API in SQL;
 * acceptance is a P1 write action (spec 45 §3) and is not offered here.
 */
export default function PortalQuotesPage() {
  const { data, error, loading, reload } = usePortalResource<PortalListResponse<PortalQuote>>(
    (signal) => listPortalQuotes(signal),
    [],
  )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Quotes</h1>
        <p className="mt-1 text-sm text-muted-foreground">Quotes we have shared with you.</p>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading quotes">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data || data.data.length === 0 ? (
        <EmptyState
          title="No quotes yet"
          description="Quotes appear here once we send them to you."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {data.data.map((quote) => (
            <li key={quote.id} className="rounded-lg border p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">{quote.number}</p>
                  <p className="text-sm text-muted-foreground">
                    Valid until {formatPortalDate(quote.expiresAt)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={quoteTone(quote.status)}>{quote.status}</Badge>
                  <p className="font-medium">
                    {formatMoneyCents(quote.grandTotalCents, quote.currency)}
                  </p>
                </div>
              </div>
              {quote.terms ? (
                <p className="mt-3 whitespace-pre-line text-sm text-muted-foreground">
                  {quote.terms}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
