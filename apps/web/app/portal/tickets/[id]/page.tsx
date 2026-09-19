"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { Badge, EmptyState, ErrorState, Skeleton } from "@yourcrm/ui"
import {
  formatPortalDate,
  getPortalTicket,
  ticketTone,
  type PortalTicket,
} from "../../portal-client"
import { usePortalResource } from "../../use-portal-resource"

/**
 * One of the customer's own tickets.
 *
 * Only public replies are shown, and that is enforced in the API: internal
 * comments are filtered out of the response before it is serialised, and a
 * comment whose visibility cannot be read is treated as internal. A ticket
 * that belongs to somebody else answers 404 here, identically to one that
 * does not exist.
 */
export default function PortalTicketDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id ?? ""
  const { data, error, loading, reload } = usePortalResource<PortalTicket>(
    (signal) => getPortalTicket(id, signal),
    [id],
  )

  if (loading) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading ticket">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <ErrorState message={error} onRetry={reload} />
        <Link href="/portal/tickets" className="text-sm underline">
          Back to tickets
        </Link>
      </div>
    )
  }

  if (!data) return <EmptyState title="That ticket is not available." />

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/portal/tickets" className="text-sm text-muted-foreground underline">
          Back to tickets
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{data.subject}</h1>
          <Badge tone={ticketTone(data.status)}>{data.status}</Badge>
          {data.priority ? <Badge tone="outline">{data.priority} priority</Badge> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Opened {formatPortalDate(data.createdAt)} · Updated{" "}
          {formatPortalDate(data.updatedAt ?? data.createdAt)}
        </p>
      </div>

      <section className="flex flex-col gap-3" aria-label="Conversation">
        <h2 className="text-lg font-medium">Conversation</h2>
        {data.comments.length === 0 ? (
          <EmptyState
            title="No replies yet"
            description="You will see our replies here as soon as we respond."
          />
        ) : (
          <ol className="flex flex-col gap-3">
            {data.comments.map((comment) => (
              <li key={comment.id} className="rounded-lg border p-4">
                <p className="text-sm font-medium">
                  {comment.authorKind === "customer" ? "You" : (comment.authorName ?? "Support")}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {formatPortalDate(comment.createdAt)}
                  </span>
                </p>
                <p className="mt-2 whitespace-pre-line text-sm">{comment.body}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
