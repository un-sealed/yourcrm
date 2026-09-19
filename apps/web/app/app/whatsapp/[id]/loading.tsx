import { Skeleton } from "@yourcrm/ui"

/** Loading skeleton for a WhatsApp conversation thread: preserves the layout. */
export default function WhatsAppThreadLoading() {
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-4"
      aria-busy="true"
      aria-label="Loading conversation"
    >
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-96 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}
