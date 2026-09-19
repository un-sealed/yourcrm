"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Skeleton,
  Tabs,
  TextArea,
  TextField,
} from "@yourcrm/ui"
import { ApiError, apiFetch, apiFetchRaw } from "@/lib/api-client"
import {
  canReplay,
  deliveryStatusLabel,
  deliveryStatusTone,
  describeAttempt,
  groupEventsByDomain,
  subscriptionStatusLabel,
  subscriptionStatusTone,
  toggleEventName,
  type Paginated,
  type PublicApiKey,
  type PublicApiKeyCreated,
  type SubscribableEvent,
  type WebhookDelivery,
  type WebhookSubscription,
  type WebhookSubscriptionCreated,
} from "./types"

/**
 * API & webhooks (spec 32-api-webhooks, P0).
 *
 * Admin-only in the API (`requirePermission(..., "admin")`), so a member
 * sees the forbidden state rather than a hidden button — UI hiding is not
 * a security boundary.
 *
 * Secrets are WRITE-ONCE here. Creating a subscription or a key returns
 * the value one time and the page shows it in a copy-me panel; after that
 * there is no affordance to reveal it, because there is no endpoint behind
 * one. The list views can only ever render the masked hint and the last
 * four characters.
 */

const BASE = "/api/v1/api-webhooks"

type TabValue = "subscriptions" | "deliveries" | "keys"

type Reveal = { title: string; value: string; note: string }

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error && err.message) return err.message
  return fallback
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString()
}

export default function ApiWebhooksPage() {
  const [tab, setTab] = useState<TabValue>("subscriptions")
  const [events, setEvents] = useState<SubscribableEvent[]>([])
  const [subscriptions, setSubscriptions] = useState<WebhookSubscription[]>([])
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([])
  const [keys, setKeys] = useState<PublicApiKey[]>([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [subscriptionDraft, setSubscriptionDraft] = useState<{
    name: string
    targetUrl: string
    description: string
    eventNames: string[]
  } | null>(null)
  const [keyDraft, setKeyDraft] = useState<{ name: string; role: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WebhookSubscription | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<PublicApiKey | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [catalogue, subs, log, issued] = await Promise.all([
        apiFetch<SubscribableEvent[]>(`${BASE}/events`),
        apiFetchRaw<Paginated<WebhookSubscription>>(`${BASE}/subscriptions?limit=100`),
        apiFetchRaw<Paginated<WebhookDelivery>>(`${BASE}/deliveries?limit=50`),
        apiFetchRaw<Paginated<PublicApiKey>>(`${BASE}/keys?limit=100`),
      ])
      setEvents(catalogue)
      setSubscriptions(subs.data)
      setDeliveries(log.data)
      setKeys(issued.data)
    } catch (err) {
      setError(messageOf(err, "Could not load API keys and webhooks."))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const eventGroups = useMemo(() => groupEventsByDomain(events), [events])
  const subscriptionsById = useMemo(
    () => new Map(subscriptions.map((row) => [row.id, row])),
    [subscriptions],
  )

  const submitSubscription = async () => {
    if (!subscriptionDraft) return
    setSubmitting(true)
    setFormError(null)
    try {
      if (subscriptionDraft.eventNames.length === 0) {
        throw new Error("Choose at least one event to send.")
      }
      const created = await apiFetch<WebhookSubscriptionCreated>(`${BASE}/subscriptions`, {
        method: "POST",
        body: {
          name: subscriptionDraft.name.trim(),
          targetUrl: subscriptionDraft.targetUrl.trim(),
          description:
            subscriptionDraft.description.trim() === ""
              ? null
              : subscriptionDraft.description.trim(),
          eventNames: subscriptionDraft.eventNames,
        },
      })
      setSubscriptionDraft(null)
      setReveal({
        title: `Signing secret for ${created.subscription.name}`,
        value: created.signingSecret,
        note: "Copy it now. It is encrypted before storage and cannot be shown again — only rotated.",
      })
      await load()
    } catch (err) {
      setFormError(messageOf(err, "Could not create this subscription."))
    } finally {
      setSubmitting(false)
    }
  }

  const rotateSecret = async (subscription: WebhookSubscription) => {
    setBusyId(subscription.id)
    try {
      const rotated = await apiFetch<WebhookSubscriptionCreated>(
        `${BASE}/subscriptions/${subscription.id}/secret`,
        { method: "POST" },
      )
      setReveal({
        title: `New signing secret for ${subscription.name}`,
        value: rotated.signingSecret,
        note: "The previous secret stopped working immediately. Update the subscriber now.",
      })
      await load()
    } catch (err) {
      setError(messageOf(err, "Could not rotate the signing secret."))
    } finally {
      setBusyId(null)
    }
  }

  const setActive = async (subscription: WebhookSubscription, active: boolean) => {
    setBusyId(subscription.id)
    try {
      await apiFetch<WebhookSubscription>(`${BASE}/subscriptions/${subscription.id}`, {
        method: "PATCH",
        body: { active },
      })
      setNotice(`${subscription.name} ${active ? "resumed" : "paused"}.`)
      await load()
    } catch (err) {
      setError(messageOf(err, "Could not update this subscription."))
    } finally {
      setBusyId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setSubmitting(true)
    try {
      await apiFetch<{ deleted: boolean }>(`${BASE}/subscriptions/${deleteTarget.id}`, {
        method: "DELETE",
      })
      setNotice(`${deleteTarget.name} deleted. Its delivery history is kept.`)
      setDeleteTarget(null)
      await load()
    } catch (err) {
      setError(messageOf(err, "Could not delete this subscription."))
    } finally {
      setSubmitting(false)
    }
  }

  const replay = async (delivery: WebhookDelivery) => {
    setBusyId(delivery.id)
    try {
      await apiFetch<WebhookDelivery>(`${BASE}/deliveries/${delivery.id}/replay`, {
        method: "POST",
      })
      setNotice("Replay queued as a new delivery.")
      await load()
    } catch (err) {
      setError(messageOf(err, "Could not replay this delivery."))
    } finally {
      setBusyId(null)
    }
  }

  const submitKey = async () => {
    if (!keyDraft) return
    setSubmitting(true)
    setFormError(null)
    try {
      const created = await apiFetch<PublicApiKeyCreated>(`${BASE}/keys`, {
        method: "POST",
        body: { name: keyDraft.name.trim(), role: keyDraft.role },
      })
      setKeyDraft(null)
      setReveal({
        title: `API key ${created.apiKey.name}`,
        value: created.key,
        note: "Copy it now. Only a hash is stored, so this is the only time it can be shown.",
      })
      await load()
    } catch (err) {
      setFormError(messageOf(err, "Could not create this API key."))
    } finally {
      setSubmitting(false)
    }
  }

  const confirmRevoke = async () => {
    if (!revokeTarget) return
    setSubmitting(true)
    try {
      await apiFetch<PublicApiKey>(`${BASE}/keys/${revokeTarget.id}`, { method: "DELETE" })
      setNotice(`${revokeTarget.name} revoked. Requests using it now fail immediately.`)
      setRevokeTarget(null)
      await load()
    } catch (err) {
      setError(messageOf(err, "Could not revoke this key."))
    } finally {
      setSubmitting(false)
    }
  }

  if (error !== null && !loading && subscriptions.length === 0 && keys.length === 0) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  const subscriptionsPanel = loading ? (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {[0, 1, 2].map((key) => (
        <Skeleton key={key} className="h-24 w-full" />
      ))}
    </div>
  ) : subscriptions.length === 0 ? (
    <EmptyState
      title="No webhook subscriptions yet"
      description="Point YourCRM at an HTTPS endpoint and it will POST a signed copy of every event you choose."
      action={
        <Button
          type="button"
          onClick={() => {
            setFormError(null)
            setSubscriptionDraft({ name: "", targetUrl: "", description: "", eventNames: [] })
          }}
        >
          Add a subscription
        </Button>
      }
    />
  ) : (
    <ul className="flex flex-col gap-3">
      {subscriptions.map((subscription) => (
        <li key={subscription.id} className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <h3 className="font-medium">{subscription.name}</h3>
                <Badge tone={subscriptionStatusTone(subscription)}>
                  {subscriptionStatusLabel(subscription)}
                </Badge>
              </div>
              <p className="break-all text-xs text-muted-foreground">{subscription.targetUrl}</p>
              <p className="text-xs text-muted-foreground">
                Signing secret {subscription.secretHint ?? "—"} · last delivery{" "}
                {formatWhen(subscription.lastDeliveryAt)}
              </p>
            </div>
            <div className="flex flex-wrap gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyId === subscription.id}
                onClick={() => void setActive(subscription, !subscription.active)}
              >
                {subscription.active ? "Pause" : "Resume"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busyId === subscription.id}
                onClick={() => void rotateSecret(subscription)}
              >
                Rotate secret
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => setDeleteTarget(subscription)}
              >
                Delete
              </Button>
            </div>
          </div>
          {subscription.disabledReason ? (
            <p className="mt-2 text-xs text-destructive">{subscription.disabledReason}</p>
          ) : null}
          <ul className="mt-3 flex flex-wrap gap-1" aria-label="Subscribed events">
            {subscription.eventNames.map((name) => (
              <li key={name}>
                <Badge tone="outline">{name}</Badge>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )

  const deliveriesPanel = loading ? (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2, 3].map((key) => (
        <Skeleton key={key} className="h-14 w-full" />
      ))}
    </div>
  ) : deliveries.length === 0 ? (
    <EmptyState
      title="No deliveries yet"
      description="Deliveries appear here as soon as a subscribed event happens. Every attempt is logged with its status code and duration."
    />
  ) : (
    <ul className="flex flex-col gap-2">
      {deliveries.map((delivery) => {
        const subscription = subscriptionsById.get(delivery.subscriptionId)
        const open = expanded === delivery.id
        return (
          <li key={delivery.id} className="rounded-lg border bg-card p-3 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={deliveryStatusTone(delivery.status)}>
                    {deliveryStatusLabel(delivery.status)}
                  </Badge>
                  <span className="text-sm font-medium">{delivery.eventName}</span>
                  <span className="text-xs text-muted-foreground">
                    {subscription?.name ?? delivery.subscriptionId}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {delivery.attemptCount} of {delivery.maxAttempts} attempts ·{" "}
                  {formatWhen(delivery.createdAt)}
                  {delivery.replayOfId ? " · replay" : ""}
                </p>
              </div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : delivery.id)}
                >
                  {open ? "Hide attempts" : "Attempts"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canReplay(delivery) || busyId === delivery.id}
                  title={
                    canReplay(delivery)
                      ? "Send this payload again as a new delivery"
                      : "Still retrying — replay is available once it settles"
                  }
                  onClick={() => void replay(delivery)}
                >
                  Replay
                </Button>
              </div>
            </div>
            {delivery.deadLetterReason ? (
              <p className="mt-2 text-xs text-destructive">{delivery.deadLetterReason}</p>
            ) : null}
            {open ? (
              <ol className="mt-3 flex flex-col gap-1 border-t pt-2">
                {(delivery.attempts ?? []).map((attempt) => (
                  <li key={attempt.attempt} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{describeAttempt(attempt)}</span>
                    {attempt.responseSnippet ? ` — ${attempt.responseSnippet}` : ""}
                    {attempt.error && !attempt.responseSnippet ? ` — ${attempt.error}` : ""}
                  </li>
                ))}
                {(delivery.attempts ?? []).length === 0 ? (
                  <li className="text-xs text-muted-foreground">No attempts recorded yet.</li>
                ) : null}
              </ol>
            ) : null}
          </li>
        )
      })}
    </ul>
  )

  const keysPanel = loading ? (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1].map((key) => (
        <Skeleton key={key} className="h-16 w-full" />
      ))}
    </div>
  ) : keys.length === 0 ? (
    <EmptyState
      title="No API keys yet"
      description="An API key authenticates a script or service as this workspace, at a role you choose. It can never do more than that role allows."
      action={
        <Button
          type="button"
          onClick={() => {
            setFormError(null)
            setKeyDraft({ name: "", role: "viewer" })
          }}
        >
          Create a key
        </Button>
      }
    />
  ) : (
    <ul className="flex flex-col gap-2">
      {keys.map((key) => (
        <li
          key={key.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3 shadow-sm"
        >
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{key.name}</span>
              <Badge tone={key.revokedAt ? "secondary" : "info"}>
                {key.revokedAt ? "Revoked" : key.role}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              <code>
                {key.keyPrefix}_…{key.lastFour}
              </code>{" "}
              · last used {formatWhen(key.lastUsedAt)}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={Boolean(key.revokedAt)}
            onClick={() => setRevokeTarget(key)}
          >
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  )

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">API &amp; webhooks</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Send signed events to your own HTTPS endpoints, and issue API keys for scripts and
            services. Secrets are shown once at creation and stored hashed or encrypted — they can
            be replaced, never read back.
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
          {tab === "keys" ? (
            <Button
              type="button"
              onClick={() => {
                setFormError(null)
                setKeyDraft({ name: "", role: "viewer" })
              }}
            >
              New API key
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => {
                setFormError(null)
                setSubscriptionDraft({ name: "", targetUrl: "", description: "", eventNames: [] })
              }}
            >
              New subscription
            </Button>
          )}
        </div>
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

      <Tabs
        ariaLabel="API and webhooks"
        value={tab}
        onValueChange={(next) => setTab(next as TabValue)}
        items={[
          {
            value: "subscriptions",
            label: `Subscriptions (${subscriptions.length})`,
            content: subscriptionsPanel,
          },
          {
            value: "deliveries",
            label: `Deliveries (${deliveries.length})`,
            content: deliveriesPanel,
          },
          { value: "keys", label: `API keys (${keys.length})`, content: keysPanel },
        ]}
      />

      {/* The once-only reveal. There is no way back to this value. */}
      <Dialog
        open={reveal !== null}
        onOpenChange={(open) => {
          if (!open) setReveal(null)
        }}
        title={reveal?.title ?? ""}
        description={reveal?.note ?? ""}
      >
        {reveal ? (
          <div className="flex flex-col gap-3">
            <code className="block break-all rounded-md border bg-muted/40 p-3 text-xs">
              {reveal.value}
            </code>
            <div className="flex justify-end">
              <Button type="button" onClick={() => setReveal(null)}>
                I have copied it
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={subscriptionDraft !== null}
        onOpenChange={(open) => {
          if (!open) setSubscriptionDraft(null)
        }}
        title="New webhook subscription"
        description="The target must be a public HTTPS URL. Private and loopback addresses are refused, both now and again before every delivery."
      >
        {subscriptionDraft ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void submitSubscription()
            }}
          >
            <Field label="Name" htmlFor="hook-name" required>
              <TextField
                id="hook-name"
                value={subscriptionDraft.name}
                required
                maxLength={255}
                onChange={(event) =>
                  setSubscriptionDraft({ ...subscriptionDraft, name: event.currentTarget.value })
                }
              />
            </Field>
            <Field
              label="Target URL"
              htmlFor="hook-url"
              hint="HTTPS only. We POST a JSON event envelope signed with HMAC-SHA256."
              required
            >
              <TextField
                id="hook-url"
                type="url"
                inputMode="url"
                placeholder="https://example.com/webhooks/yourcrm"
                value={subscriptionDraft.targetUrl}
                required
                onChange={(event) =>
                  setSubscriptionDraft({
                    ...subscriptionDraft,
                    targetUrl: event.currentTarget.value,
                  })
                }
              />
            </Field>
            <Field label="Notes" htmlFor="hook-notes">
              <TextArea
                id="hook-notes"
                rows={2}
                value={subscriptionDraft.description}
                onChange={(event) =>
                  setSubscriptionDraft({
                    ...subscriptionDraft,
                    description: event.currentTarget.value,
                  })
                }
              />
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">
                Events ({subscriptionDraft.eventNames.length} selected)
              </legend>
              <div className="max-h-56 overflow-y-auto rounded-md border p-2">
                {eventGroups.map((group) => (
                  <div key={group.domain} className="mb-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.domain}
                    </p>
                    {group.names.map((name) => (
                      <label key={name} className="flex items-center gap-2 py-0.5 text-sm">
                        <Checkbox
                          checked={subscriptionDraft.eventNames.includes(name)}
                          onChange={() =>
                            setSubscriptionDraft({
                              ...subscriptionDraft,
                              eventNames: toggleEventName(subscriptionDraft.eventNames, name),
                            })
                          }
                        />
                        <span>{name}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </fieldset>
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
                onClick={() => setSubscriptionDraft(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create"}
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>

      <Dialog
        open={keyDraft !== null}
        onOpenChange={(open) => {
          if (!open) setKeyDraft(null)
        }}
        title="New API key"
        description="The key is shown once. Only its hash is stored, so it cannot be recovered — only revoked and replaced."
      >
        {keyDraft ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void submitKey()
            }}
          >
            <Field label="Name" htmlFor="key-name" hint="Where will it be used?" required>
              <TextField
                id="key-name"
                value={keyDraft.name}
                required
                maxLength={255}
                onChange={(event) => setKeyDraft({ ...keyDraft, name: event.currentTarget.value })}
              />
            </Field>
            <Field
              label="Role"
              htmlFor="key-role"
              hint="The key can never do more than this role allows, and never more than you can do yourself."
              required
            >
              <Select
                id="key-role"
                value={keyDraft.role}
                options={[
                  { value: "viewer", label: "Viewer — read only" },
                  { value: "member", label: "Member — read and write" },
                  { value: "admin", label: "Admin — full workspace access" },
                ]}
                onChange={(event) => setKeyDraft({ ...keyDraft, role: event.currentTarget.value })}
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
                onClick={() => setKeyDraft(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create key"}
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={`Delete ${deleteTarget?.name ?? ""}?`}
        description="Deliveries stop immediately and the signing secret is gone for good. The delivery history is kept."
        confirmLabel="Delete"
        danger
        loading={submitting}
        onConfirm={() => void confirmDelete()}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null)
        }}
        title={`Revoke ${revokeTarget?.name ?? ""}?`}
        description="Any script still using this key starts failing straight away. This cannot be undone — issue a new key instead."
        confirmLabel="Revoke"
        danger
        loading={submitting}
        onConfirm={() => void confirmRevoke()}
      />
    </div>
  )
}
