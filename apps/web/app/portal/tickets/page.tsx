"use client"

import Link from "next/link"
import { Badge, EmptyState, ErrorState, Skeleton } from "@yourcrm/ui"
import {
  formatPortalDate,
  listPortalTickets,
  ticketTone,
  type PortalListResponse,
  type PortalTicket,
} from "../portal-client"
import { usePortalResource } from "../use-portal-resource"

/**
 * The customer's own tickets.
 *
 * The support module owns the ticket tables and is wired into the portal
 * through a scoped reader port. Until an integrator binds it, this list is
 * legitimately empty — the portal reports "no tickets" rather than reading
 * anything unscoped.
 */
export default function PortalTicketsPage() {
  const { data, error, loading, reload } = usePortalResource<PortalListResponse<PortalTicket>>(
    (signal) => listPortalTickets(signal),
    [],
  )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Support tickets</h1>
        <p className="mt-1 text-sm text-muted-foreground">Requests you have raised with us.</p>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading tickets">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data || data.data.length === 0 ? (
        <EmptyState
          title="No tickets yet"
          description="When you raise a support request with us it will appear here."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {data.data.map((ticket) => (
            <li key={ticket.id}>
              <Link
                href={`/portal/tickets/${ticket.id}`}
                className="flex flex-col gap-2 rounded-lg border p-4 transition-colors hover:bg-secondary/50 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium">{ticket.subject}</p>
                  <p className="text-sm text-muted-foreground">
                    Updated {formatPortalDate(ticket.updatedAt ?? ticket.createdAt)}
                  </p>
                </div>
                <Badge tone={ticketTone(ticket.status)}>{ticket.status}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
