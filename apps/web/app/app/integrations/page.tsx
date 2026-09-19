"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Skeleton,
  TextArea,
  TextField,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  capabilityLabel,
  connectionsForProvider,
  groupProvidersByCategory,
  statusLabel,
  statusTone,
  type IntegrationConnection,
  type IntegrationConnectionDetail,
  type IntegrationConnectionListResponse,
  type IntegrationProviderSummary,
} from "./types"

/**
 * Integrations catalogue (spec 31-integrations, P0).
 *
 * Admin-only in the API (`requirePermission(..., "admin")`), so a member sees
 * the forbidden state rather than a hidden button — UI hiding is not a
 * security boundary.
 *
 * Credentials are WRITE-ONLY here: the connect and rotate forms send secrets
 * up, and the page can only ever display the masked hint the API returns.
 * There is no "reveal" affordance because there is no endpoint behind one.
 */

type ConnectDraft = {
  provider: IntegrationProviderSummary
  displayName: string
  apiKey: string
  webhookSecret: string
  config: string
}

type RotateDraft = {
  connection: IntegrationConnection
  apiKey: string
  webhookSecret: string
}

function parseConfig(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (trimmed === "") return {}
  const parsed: unknown = JSON.parse(trimmed)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Settings must be a JSON object, e.g. {}")
  }
  return parsed as Record<string, unknown>
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

export default function IntegrationsPage() {
  const [providers, setProviders] = useState<IntegrationProviderSummary[]>([])
  const [connections, setConnections] = useState<IntegrationConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [connectDraft, setConnectDraft] = useState<ConnectDraft | null>(null)
  const [rotateDraft, setRotateDraft] = useState<RotateDraft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [disconnectTarget, setDisconnectTarget] = useState<IntegrationConnection | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [catalogue, installed] = await Promise.all([
        apiFetch<IntegrationProviderSummary[]>("/api/v1/integrations/providers"),
        apiFetchRaw<IntegrationConnectionListResponse>("/api/v1/integrations?limit=100"),
      ])
      setProviders(catalogue)
      setConnections(installed.data)
    } catch (err) {
      setError(messageOf(err, "Could not load integrations."))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const groups = useMemo(() => groupProvidersByCategory(providers), [providers])

  const submitConnect = async () => {
    if (!connectDraft) return
    setSubmitting(true)
    setFormError(null)
    try {
      const body: Record<string, unknown> = {
        providerId: connectDraft.provider.id,
        displayName: connectDraft.displayName.trim(),
        config: parseConfig(connectDraft.config),
        apiKey: connectDraft.apiKey,
      }
      if (connectDraft.webhookSecret.trim() !== "") {
        body.webhookSecret = connectDraft.webhookSecret.trim()
      }
      const detail = await apiFetch<IntegrationConnectionDetail>("/api/v1/integrations", {
        method: "POST",
        body,
      })
      setConnectDraft(null)
      setNotice(`${detail.connection.displayName} connected.`)
      await load()
    } catch (err) {
      setFormError(messageOf(err, "Could not connect this provider."))
      // A rejected handshake still leaves a visible `error` connection the
      // admin can rotate keys on — reload so they can see it.
      await load()
    } finally {
      setSubmitting(false)
    }
  }

  const submitRotate = async () => {
    if (!rotateDraft) return
    setSubmitting(true)
    setFormError(null)
    try {
      const body: Record<string, unknown> = {}
      if (rotateDraft.apiKey.trim() !== "") body.apiKey = rotateDraft.apiKey.trim()
      if (rotateDraft.webhookSecret.trim() !== "") {
        body.webhookSecret = rotateDraft.webhookSecret.trim()
      }
      if (Object.keys(body).length === 0) {
        throw new Error("Enter a new API key, a new webhook secret, or both.")
      }
      await apiFetch<IntegrationConnectionDetail>(
        `/api/v1/integrations/${rotateDraft.connection.id}/credentials`,
        { method: "POST", body },
      )
      setRotateDraft(null)
      setNotice("Credentials rotated.")
      await load()
    } catch (err) {
      setFormError(messageOf(err, "Could not rotate these credentials."))
    } finally {
      setSubmitting(false)
    }
  }

  const runHealthCheck = async (connection: IntegrationConnection) => {
    setBusyId(connection.id)
    setNotice(null)
    try {
      const updated = await apiFetch<IntegrationConnection>(
        `/api/v1/integrations/${connection.id}/health`,
        { method: "POST" },
      )
      setNotice(`${connection.displayName}: ${statusLabel(updated.status).toLowerCase()}.`)
      await load()
    } catch (err) {
      setError(messageOf(err, "Health check failed."))
    } finally {
      setBusyId(null)
    }
  }

  const confirmDisconnect = async () => {
    if (!disconnectTarget) return
    setSubmitting(true)
    try {
      await apiFetch<IntegrationConnection>(`/api/v1/integrations/${disconnectTarget.id}`, {
        method: "DELETE",
      })
      setNotice(`${disconnectTarget.displayName} disconnected and its credentials revoked.`)
      setDisconnectTarget(null)
      await load()
    } catch (err) {
      setError(messageOf(err, "Could not disconnect."))
    } finally {
      setSubmitting(false)
    }
  }

  if (error !== null && !loading && providers.length === 0) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Integrations</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Connect this workspace to the tools it already uses. Credentials are encrypted before
            they are stored and are never shown again — only a masked hint.
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

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-40 w-full" />
          ))}
        </div>
      ) : providers.length === 0 ? (
        <EmptyState
          title="No providers available"
          description="No connector has been registered in this deployment yet. Register a provider adapter with the integrations registry and it appears here automatically."
        />
      ) : (
        groups.map((group) => (
          <section key={group.category} className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {group.category}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.providers.map((provider) => {
                const installed = connectionsForProvider(connections, provider.id)
                return (
                  <article
                    key={provider.id}
                    className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-panel"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-col gap-1">
                        <h3 className="font-medium">{provider.displayName}</h3>
                        {provider.description ? (
                          <p className="text-xs text-muted-foreground">{provider.description}</p>
                        ) : null}
                      </div>
                      {installed.length > 0 ? (
                        <Badge tone="info">{installed.length} connected</Badge>
                      ) : null}
                    </div>

                    <ul className="flex flex-wrap gap-1" aria-label="Capabilities">
                      {provider.capabilities.map((capability) => (
                        <li key={capability}>
                          <Badge tone="outline">{capabilityLabel(capability)}</Badge>
                        </li>
                      ))}
                    </ul>

                    {installed.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Not connected yet.</p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {installed.map((connection) => (
                          <li key={connection.id} className="rounded-md border p-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-sm font-medium">{connection.displayName}</span>
                              <Badge tone={statusTone(connection.status)}>
                                {statusLabel(connection.status)}
                              </Badge>
                            </div>
                            {connection.lastError ? (
                              <p className="mt-1 text-xs text-destructive">
                                {connection.lastError}
                              </p>
                            ) : null}
                            <div className="mt-2 flex flex-wrap gap-1">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={busyId === connection.id}
                                onClick={() => void runHealthCheck(connection)}
                              >
                                {busyId === connection.id ? "Checking…" : "Check health"}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setFormError(null)
                                  setRotateDraft({ connection, apiKey: "", webhookSecret: "" })
                                }}
                              >
                                Rotate keys
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                onClick={() => setDisconnectTarget(connection)}
                              >
                                Disconnect
                              </Button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="mt-auto flex items-center justify-between gap-2">
                      {provider.docsUrl ? (
                        <a
                          href={provider.docsUrl}
                          className="text-xs text-primary hover:underline"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Setup guide
                        </a>
                      ) : (
                        <span />
                      )}
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          setFormError(null)
                          setConnectDraft({
                            provider,
                            displayName: provider.displayName,
                            apiKey: "",
                            webhookSecret: "",
                            config: "{}",
                          })
                        }}
                      >
                        Connect
                      </Button>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ))
      )}

      <Dialog
        open={connectDraft !== null}
        onOpenChange={(open) => {
          if (!open) setConnectDraft(null)
        }}
        title={`Connect ${connectDraft?.provider.displayName ?? ""}`}
        description="The secret is encrypted before it is stored and can never be read back — only replaced."
      >
        {connectDraft ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void submitConnect()
            }}
          >
            <Field label="Name" htmlFor="integration-name" required>
              <TextField
                id="integration-name"
                value={connectDraft.displayName}
                required
                maxLength={255}
                onChange={(event) =>
                  setConnectDraft({ ...connectDraft, displayName: event.currentTarget.value })
                }
              />
            </Field>
            <Field
              label={connectDraft.provider.secretLabel ?? "API key"}
              htmlFor="integration-secret"
              hint="Stored encrypted with AES-256-GCM. Shown afterwards only as a masked hint."
              required
            >
              <TextField
                id="integration-secret"
                type="password"
                autoComplete="off"
                value={connectDraft.apiKey}
                required
                minLength={8}
                onChange={(event) =>
                  setConnectDraft({ ...connectDraft, apiKey: event.currentTarget.value })
                }
              />
            </Field>
            {connectDraft.provider.supportsWebhooks ? (
              <Field
                label="Webhook signing secret"
                htmlFor="integration-webhook-secret"
                hint="The secret this provider signs inbound deliveries with. Optional — without it, webhooks are rejected."
              >
                <TextField
                  id="integration-webhook-secret"
                  type="password"
                  autoComplete="off"
                  value={connectDraft.webhookSecret}
                  onChange={(event) =>
                    setConnectDraft({ ...connectDraft, webhookSecret: event.currentTarget.value })
                  }
                />
              </Field>
            ) : null}
            <Field
              label="Advanced settings (JSON)"
              htmlFor="integration-config"
              hint="Provider-specific, non-secret settings. Leave as {} unless the setup guide says otherwise."
            >
              <TextArea
                id="integration-config"
                rows={3}
                value={connectDraft.config}
                onChange={(event) =>
                  setConnectDraft({ ...connectDraft, config: event.currentTarget.value })
                }
              />
            </Field>
            {formError !== null ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {formError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => setConnectDraft(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Connecting…" : "Connect"}
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>

      <Dialog
        open={rotateDraft !== null}
        onOpenChange={(open) => {
          if (!open) setRotateDraft(null)
        }}
        title={`Rotate credentials for ${rotateDraft?.connection.displayName ?? ""}`}
        description="A new API key is re-verified with the provider before it replaces the old one."
      >
        {rotateDraft ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void submitRotate()
            }}
          >
            <Field
              label="New API key"
              htmlFor="rotate-api-key"
              hint="Leave blank to keep the current key."
            >
              <TextField
                id="rotate-api-key"
                type="password"
                autoComplete="off"
                value={rotateDraft.apiKey}
                onChange={(event) =>
                  setRotateDraft({ ...rotateDraft, apiKey: event.currentTarget.value })
                }
              />
            </Field>
            <Field
              label="New webhook signing secret"
              htmlFor="rotate-webhook-secret"
              hint="Leave blank to keep the current secret."
            >
              <TextField
                id="rotate-webhook-secret"
                type="password"
                autoComplete="off"
                value={rotateDraft.webhookSecret}
                onChange={(event) =>
                  setRotateDraft({ ...rotateDraft, webhookSecret: event.currentTarget.value })
                }
              />
            </Field>
            {formError !== null ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {formError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => setRotateDraft(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Rotating…" : "Rotate"}
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={disconnectTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnectTarget(null)
        }}
        title={`Disconnect ${disconnectTarget?.displayName ?? ""}?`}
        description="Stored credentials are deleted immediately. Inbound webhooks stop being accepted. The connection history is kept."
        confirmLabel="Disconnect"
        danger
        loading={submitting}
        onConfirm={() => void confirmDisconnect()}
      />
    </div>
  )
}
