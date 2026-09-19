import Link from "next/link"

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        The page you asked for doesn&apos;t exist.
      </p>
      <Link href="/app/dashboard" className="mt-4 text-sm underline">
        Back to dashboard
      </Link>
    </div>
  )
}
