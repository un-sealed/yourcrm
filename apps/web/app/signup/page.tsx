"use client"

/**
 * Signup page (Wave-1 auth, spec 04). Creates the user + workspace + owner
 * membership in one API call; the API sets the session cookie on success.
 * Until the platform-seams agent mounts `POST /api/v1/auth/signup`,
 * submissions surface the API error state below.
 */

import { useState, type FormEvent } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@yourcrm/ui"
import { getClientEnv } from "@/lib/env"

export default function SignupPage() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setPending(true)
    try {
      const { NEXT_PUBLIC_API_URL } = getClientEnv()
      const res = await fetch(`${NEXT_PUBLIC_API_URL}/api/v1/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string }
        } | null
        setError(
          body?.error?.code === "EMAIL_TAKEN"
            ? "An account with this email already exists."
            : (body?.error?.message ?? "Could not create your workspace."),
        )
        return
      }
      router.push("/")
      router.refresh()
    } catch {
      setError("Could not reach the API. Is it running?")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8">
      <h1 className="text-2xl font-semibold">Create your workspace</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        One account, unlimited pipelines. Free to self-host.
      </p>
      <form className="mt-6 flex flex-col gap-3" onSubmit={onSubmit}>
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            className="rounded-md border bg-transparent px-3 py-2 text-sm"
            placeholder="Ada Lovelace"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Work email
          <input
            className="rounded-md border bg-transparent px-3 py-2 text-sm"
            placeholder="you@company.com"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            className="rounded-md border bg-transparent px-3 py-2 text-sm"
            placeholder="At least 8 characters"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? "Creating workspace…" : "Create workspace"}
        </Button>
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
