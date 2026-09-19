"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { Badge, Button, ConfirmDialog, ErrorState, Skeleton } from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  formatScope,
  parseScopeString,
  statusLabel,
  statusTone,
  type AppInstallationListResponse,
  type AppScope,
  type InstallationDetail,
  type InstallResult,
  type MarketplaceApp,
} from "../types"

/**
 * App detail (spec 49-marketplace-sdk, P0).
 *
 * Scope consent lives here, plainly, before an install ever happens: the
 * requested scopes render as a list on the page itself (not hidden behind a
 * tooltip or a collapsed section), and installing is a two-step action — the
 * confirm dialog restates exactly what is about to be granted. This is the
 * only place in the app that calls install; the catalogue list only links
 * here.
 */

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

export default function MarketplaceAppDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id

  const [app, setApp] = useState<MarketplaceApp | null>(null)
  const [installationId, setInstallationId] = useState<string | null>(null)
  const [detail, setDetail] = useState<InstallationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmInstall, setConfirmInstall] = useState(false)
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [appData, installations] = await Promise.all([
        apiFetch<MarketplaceApp>(`/api/v1/marketplace/apps/${id}`),
        apiFetchRaw<AppInstallationListResponse>("/api/v1/marketplace/installations?limit=100"),
      ])
      setApp(appData)
      const active = installations.data.find(
        (installation) => installation.appId === appData.id && installation.status === "active",
      )
      if (active) {
        setInstallationId(active.id)
        const installationDetail = await apiFetch<InstallationDetail>(
          `/api/v1/marketplace/installations/${active.id}`,
        )
        setDetail(installationDetail)
      } else {
        setInstallationId(null)
        setDetail(null)
      }
    } catch (err) {
      setError(messageOf(err, "Could not load this app."))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const submitInstall = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const result = await apiFetch<InstallResult>(`/api/v1/marketplace/apps/${id}/install`, {
        method: "POST",
      })
      setConfirmInstall(false)
      setNotice(
        result.deniedScopes.length > 0
          ? `Installed with ${result.grantedScopes.length} of ${
              result.grantedScopes.length + result.deniedScopes.length
            } requested scopes — your role could not grant the rest.`
          : `Installed. All ${result.grantedScopes.length} requested scopes were granted.`,
      )
      await load()
    } catch (err) {
      setError(messageOf(err, "Could not install this app."))
    } finally {
      setSubmitting(false)
    }
  }

  const submitUninstall = async () => {
    if (!installationId) return
    setSubmitting(true)
    setError(null)
    try {
      await apiFetch<{ uninstalled: boolean }>(
        `/api/v1/marketplace/installations/${installationId}`,
        { method: "DELETE" },
      )
      setConfirmUninstall(false)
      setNotice("Uninstalled. Every granted scope was revoked.")
      await load()
    } catch (err) {
      setError(messageOf(err, "Could not uninstall this app."))
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading app">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }

  if (error !== null && app === null) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  if (app === null) return null

  const requestedScopes: AppScope[] = app.manifest.scopes.map(parseScopeString)
  const grantedKeys = new Set((detail?.grants ?? []).map((g) => `${g.object}:${g.action}`))
  const isInstalled = installationId !== null

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/app/marketplace" className="text-xs text-primary hover:underline">
          ← Back to marketplace
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{app.name}</h1>
          <p className="text-sm text-muted-foreground">
            {app.publisher} · v{app.version}
          </p>
          {app.description ? (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{app.description}</p>
          ) : null}
          {app.manifest.docsUrl ? (
            <a
              href={app.manifest.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary hover:underline"
            >
              Documentation
            </a>
          ) : null}
        </div>
        <Badge tone={isInstalled ? "success" : statusTone(app.status)}>
          {isInstalled ? "Installed" : statusLabel(app.status)}
        </Badge>
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

      <section className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">
          {isInstalled ? "Granted access" : "This app is requesting access to"}
        </h2>
        <p className="text-xs text-muted-foreground">
          {isInstalled
            ? "Exactly what this installation may do. Uninstalling revokes all of it."
            : "Review this list before installing. You will never grant more than your own role permits, even if the app asks for more."}
        </p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {requestedScopes.map((scope) => {
            const key = formatScope(scope)
            const granted = !isInstalled || grantedKeys.has(`${scope.object}:${scope.action}`)
            return (
              <li key={key} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-mono text-xs">{scope.object}</span>
                  <span className="text-muted-foreground"> · </span>
                  <span className="font-mono text-xs">{scope.action}</span>
                </span>
                {isInstalled ? (
                  <Badge tone={granted ? "success" : "secondary"}>
                    {granted ? "Granted" : "Not granted (exceeded your role)"}
                  </Badge>
                ) : null}
              </li>
            )
          })}
        </ul>
      </section>

      {app.manifest.webhooks.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Declared webhooks</h2>
          <p className="text-xs text-muted-foreground">
            Events this app wants to know about. Not yet delivered in this release — see{" "}
            <code>MARKETPLACE.md</code>.
          </p>
          <ul className="mt-1 flex flex-wrap gap-1">
            {app.manifest.webhooks.map((hook) => (
              <li key={hook.event}>
                <Badge tone="outline">{hook.event}</Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {app.manifest.uiExtensionPoints.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Declared UI extension points</h2>
          <p className="text-xs text-muted-foreground">
            Where this app wants a presence in the interface. Not yet mounted in this release.
          </p>
          <ul className="mt-1 flex flex-wrap gap-1">
            {app.manifest.uiExtensionPoints.map((point) => (
              <li key={point.location}>
                <Badge tone="outline">{point.label}</Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex justify-end gap-2">
        {isInstalled ? (
          <Button type="button" variant="destructive" onClick={() => setConfirmUninstall(true)}>
            Uninstall
          </Button>
        ) : (
          <Button type="button" onClick={() => setConfirmInstall(true)}>
            Install
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmInstall}
        onOpenChange={setConfirmInstall}
        title={`Install ${app.name}?`}
        description={`This grants ${app.name} the scopes listed above — capped by your own permissions. You can uninstall at any time to revoke everything.`}
        confirmLabel="Grant access & install"
        loading={submitting}
        onConfirm={() => void submitInstall()}
      />

      <ConfirmDialog
        open={confirmUninstall}
        onOpenChange={setConfirmUninstall}
        title={`Uninstall ${app.name}?`}
        description="Every scope this app was granted is revoked immediately. No access survives an uninstall."
        confirmLabel="Uninstall"
        danger
        loading={submitting}
        onConfirm={() => void submitUninstall()}
      />
    </div>
  )
}
