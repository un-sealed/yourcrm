"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Skeleton } from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  installationsForApp,
  statusLabel,
  statusTone,
  type AppInstallation,
  type AppInstallationListResponse,
  type MarketplaceApp,
  type MarketplaceAppListResponse,
} from "./types"

/**
 * Marketplace catalogue (spec 49-marketplace-sdk, P0).
 *
 * Browsing is open to every workspace member (`read`); install/uninstall are
 * admin-only in the API, so a non-admin sees the forbidden state on an
 * install/uninstall attempt rather than a hidden button — UI hiding is not a
 * security boundary. Scope consent lives on the detail page
 * (`./[id]/page.tsx`): this page never installs directly, only links there,
 * so a user always sees exactly what they are granting before it happens.
 */

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

export default function MarketplacePage() {
  const [apps, setApps] = useState<MarketplaceApp[]>([])
  const [installations, setInstallations] = useState<AppInstallation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<AppInstallation | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [catalogue, installed] = await Promise.all([
        apiFetchRaw<MarketplaceAppListResponse>("/api/v1/marketplace/apps?limit=100"),
        apiFetchRaw<AppInstallationListResponse>("/api/v1/marketplace/installations?limit=100"),
      ])
      setApps(catalogue.data)
      setInstallations(installed.data)
    } catch (err) {
      setError(messageOf(err, "Could not load the marketplace."))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const appById = useMemo(() => new Map(apps.map((app) => [app.id, app])), [apps])
  const activeInstallations = useMemo(
    () => installations.filter((installation) => installation.status === "active"),
    [installations],
  )

  const confirmUninstall = async () => {
    if (!uninstallTarget) return
    setSubmitting(true)
    try {
      await apiFetch<{ uninstalled: boolean }>(
        `/api/v1/marketplace/installations/${uninstallTarget.id}`,
        { method: "DELETE" },
      )
      const app = appById.get(uninstallTarget.appId)
      setNotice(`${app?.name ?? "App"} uninstalled. Every granted scope was revoked.`)
      setUninstallTarget(null)
      await load()
    } catch (err) {
      setError(messageOf(err, "Could not uninstall this app."))
    } finally {
      setSubmitting(false)
    }
  }

  if (error !== null && !loading && apps.length === 0) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Marketplace</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Apps extend YourCRM through declared, scoped access to your data — never more than what
            you approve. Open an app to see exactly what it asks for before installing.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      </header>

      {notice !== null ? (
        <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      {error !== null ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <ErrorState message={error} onRetry={() => void load()} />
        </div>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Installed
        </h2>
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
            {[0, 1].map((key) => (
              <Skeleton key={key} className="h-24 w-full" />
            ))}
          </div>
        ) : activeInstallations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No apps installed yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {activeInstallations.map((installation) => {
              const app = appById.get(installation.appId)
              return (
                <article
                  key={installation.id}
                  className="flex flex-col gap-2 rounded-lg border bg-card p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-col gap-1">
                      <h3 className="font-medium">{app?.name ?? installation.appId}</h3>
                      <p className="text-xs text-muted-foreground">v{installation.appVersion}</p>
                    </div>
                    <Badge tone={statusTone(installation.status)}>
                      {statusLabel(installation.status)}
                    </Badge>
                  </div>
                  <div className="mt-auto flex justify-between gap-2">
                    <Link
                      href={`/app/marketplace/${installation.appId}`}
                      className="text-xs text-primary hover:underline"
                    >
                      View details
                    </Link>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => setUninstallTarget(installation)}
                    >
                      Uninstall
                    </Button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Catalogue
        </h2>
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((key) => (
              <Skeleton key={key} className="h-40 w-full" />
            ))}
          </div>
        ) : apps.length === 0 ? (
          <EmptyState
            title="No apps published yet"
            description="Publish an app manifest to this workspace's catalogue and it appears here automatically."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {apps.map((app) => {
              const installedCount = installationsForApp(installations, app.id).length
              return (
                <article
                  key={app.id}
                  className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-col gap-1">
                      <h3 className="font-medium">{app.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        {app.publisher} · v{app.version}
                      </p>
                    </div>
                    {installedCount > 0 ? <Badge tone="info">Installed</Badge> : null}
                  </div>
                  {app.description ? (
                    <p className="text-xs text-muted-foreground">{app.description}</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Requests {app.manifest.scopes.length}{" "}
                    {app.manifest.scopes.length === 1 ? "scope" : "scopes"}
                  </p>
                  <div className="mt-auto flex justify-end">
                    <Link href={`/app/marketplace/${app.id}`}>
                      <Button type="button" size="sm">
                        View & install
                      </Button>
                    </Link>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={uninstallTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUninstallTarget(null)
        }}
        title={`Uninstall ${appById.get(uninstallTarget?.appId ?? "")?.name ?? "this app"}?`}
        description="Every scope this app was granted is revoked immediately. No access survives an uninstall."
        confirmLabel="Uninstall"
        danger
        loading={submitting}
        onConfirm={() => void confirmUninstall()}
      />
    </div>
  )
}
