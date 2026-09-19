"use client"

/** Signup foundation (workspace creation flow lands with onboarding). */

import Link from "next/link"
import { Button } from "@yourcrm/ui"

/** Signup foundation (workspace creation flow lands with onboarding). */
export default function SignupPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8">
      <h1 className="text-2xl font-semibold">Create your workspace</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        One account, unlimited pipelines. Free to self-host.
      </p>
      <form className="mt-6 flex flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
        <input className="rounded-md border bg-transparent px-3 py-2 text-sm" placeholder="Name" />
        <input
          className="rounded-md border bg-transparent px-3 py-2 text-sm"
          placeholder="Work email"
          type="email"
        />
        <input
          className="rounded-md border bg-transparent px-3 py-2 text-sm"
          placeholder="Password"
          type="password"
        />
        <Button type="submit">Create workspace</Button>
      </form>
      <p className="mt-4 text-sm text-muted-foreground">
        Have an account?{" "}
        <Link href="/login" className="underline">
          Log in
        </Link>
      </p>
    </div>
  )
}
