"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { EmailComposer } from "../composer"

/** Compose a new email. Replies live on the thread page instead. */
export default function NewEmailPage() {
  const router = useRouter()

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New email</h1>
        <Link href="/app/email" className="text-sm text-muted-foreground hover:underline">
          Back to email
        </Link>
      </div>
      <EmailComposer
        onCancel={() => router.push("/app/email")}
        onSent={(sent) => router.push(`/app/email/${sent.message.threadId}`)}
      />
    </div>
  )
}
