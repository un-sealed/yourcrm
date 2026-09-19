"use client"

/** Login foundation (real session flow lands with spec 04-authentication). */

import Link from "next/link"
import { Button } from "@yourcrm/ui"

/** Login foundation (real session flow lands with spec 04-authentication). */
export default function LoginPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8">
      <h1 className="text-2xl font-semibold">Log in to YourCRM</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Email + password and OAuth arrive in Phase 1.
      </p>
      <form className="mt-6 flex flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
        <input
          className="rounded-md border bg-transparent px-3 py-2 text-sm"
          placeholder="Email"
          type="email"
        />
        <input
          className="rounded-md border bg-transparent px-3 py-2 text-sm"
          placeholder="Password"
          type="password"
        />
        <Button type="submit">Log in</Button>
      </form>
      <p className="mt-4 text-sm text-muted-foreground">
        No account?{" "}
        <Link href="/signup" className="underline">
          Sign up
        </Link>
      </p>
    </div>
  )
}
