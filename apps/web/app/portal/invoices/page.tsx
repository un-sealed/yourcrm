"use client"

import { Badge, EmptyState, ErrorState, Skeleton } from "@yourcrm/ui"
import {
  formatMoneyCents,
  formatPortalDate,
  invoiceTone,
  listPortalInvoices,
  type PortalInvoice,
  type PortalListResponse,
} from "../portal-client"
import { usePortalResource } from "../use-portal-resource"

/**
 * The customer's own invoices.
 *
 * The API returns only invoices inside this identity's access grants, and
 * only those in a customer-visible status — drafts and voided invoices are
 * excluded in SQL, not here. Amounts arrive as integer minor units.
 */
export default function PortalInvoicesPage() {
  const { data, error, loading, reload } = usePortalResource<PortalListResponse<PortalInvoice>>(
    (signal) => listPortalInvoices(signal),
    [],
  )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Invoices</h1>
        <p className="mt-1 text-sm text-muted-foreground">Everything billed to your account.</p>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading invoices">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data || data.data.length === 0 ? (
        <EmptyState
          title="No invoices yet"
          description="Invoices appear here as soon as they are issued to you."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {data.data.map((invoice) => (
            <li key={invoice.id} className="rounded-lg border p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">{invoice.number}</p>
                  <p className="text-sm text-muted-foreground">
                    Due {formatPortalDate(invoice.dueDate)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={invoiceTone(invoice)}>
                    {invoice.overdue && invoice.status !== "paid" ? "overdue" : invoice.status}
                  </Badge>
                  <div className="text-right">
                    <p className="font-medium">
                      {formatMoneyCents(invoice.totalCents, invoice.currency)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {formatMoneyCents(invoice.balanceDueCents, invoice.currency)} outstanding
                    </p>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
