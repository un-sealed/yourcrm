"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  RecordHeader,
  Select,
  Skeleton,
  TextArea,
  TextField,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import { clampCell, pointToCell } from "../_components/grid-math"
import { WidgetBody } from "../_components/widget-tile"
import {
  GRID_COLUMNS,
  WIDGET_TYPE_OPTIONS,
  type DashboardDetail,
  type DashboardWidget,
  type WidgetType,
} from "../types"

const ROW_HEIGHT_PX = 96

type WidgetFormState = {
  mode: "add" | "edit"
  widgetId: string | null
  type: WidgetType
  title: string
  reportId: string
  width: number
  height: number
  configText: string
}

function emptyWidgetForm(): WidgetFormState {
  return {
    mode: "add",
    widgetId: null,
    type: "metric",
    title: "",
    reportId: "",
    width: 4,
    height: 2,
    configText: "",
  }
}

function widgetToForm(widget: DashboardWidget): WidgetFormState {
  return {
    mode: "edit",
    widgetId: widget.id,
    type: widget.type,
    title: widget.title,
    reportId: widget.reportId ?? "",
    width: widget.width,
    height: widget.height,
    configText: widget.config ? JSON.stringify(widget.config, null, 2) : "",
  }
}

/** Dashboard detail: header, editable name/description, widget grid. */
export default function DashboardDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id

  const [dashboard, setDashboard] = useState<DashboardDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const [widgetForm, setWidgetForm] = useState<WidgetFormState | null>(null)
  const [widgetFormError, setWidgetFormError] = useState<string | null>(null)
  const [widgetSubmitting, setWidgetSubmitting] = useState(false)
  const [confirmRemoveWidget, setConfirmRemoveWidget] = useState<string | null>(null)

  const [dragId, setDragId] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<DashboardDetail>(`/api/v1/dashboards/${id}`)
      setDashboard(data)
      setName(data.name)
      setDescription(data.description ?? "")
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this dashboard.")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const saveDetails = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const updated = await apiFetch<DashboardDetail>(`/api/v1/dashboards/${id}`, {
        method: "PATCH",
        body: {
          name: name.trim(),
          description: description.trim() === "" ? null : description.trim(),
        },
      })
      setDashboard((prev) => (prev ? { ...prev, ...updated } : prev))
      toast({ title: "Dashboard updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const removeDashboard = async () => {
    try {
      await apiFetch(`/api/v1/dashboards/${id}`, { method: "DELETE" })
      toast({ title: "Dashboard deleted", description: "It can be restored from trash." })
      router.push("/app/dashboards")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  const submitWidgetForm = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!widgetForm) return
    if (widgetForm.title.trim() === "") {
      setWidgetFormError("Title is required.")
      return
    }
    let config: Record<string, unknown> | null = null
    if (widgetForm.configText.trim() !== "") {
      try {
        config = JSON.parse(widgetForm.configText) as Record<string, unknown>
      } catch {
        setWidgetFormError("Config must be valid JSON (or left empty).")
        return
      }
    }
    setWidgetFormError(null)
    setWidgetSubmitting(true)
    const body = {
      type: widgetForm.type,
      title: widgetForm.title.trim(),
      width: widgetForm.width,
      height: widgetForm.height,
      reportId: widgetForm.reportId.trim() === "" ? null : widgetForm.reportId.trim(),
      config,
    }
    try {
      if (widgetForm.mode === "add") {
        const widget = await apiFetch<DashboardWidget>(`/api/v1/dashboards/${id}/widgets`, {
          method: "POST",
          body,
        })
        setDashboard((prev) => (prev ? { ...prev, widgets: [...prev.widgets, widget] } : prev))
        toast({ title: "Widget added" })
      } else if (widgetForm.widgetId) {
        const widget = await apiFetch<DashboardWidget>(
          `/api/v1/dashboards/${id}/widgets/${widgetForm.widgetId}`,
          { method: "PATCH", body },
        )
        setDashboard((prev) =>
          prev
            ? { ...prev, widgets: prev.widgets.map((w) => (w.id === widget.id ? widget : w)) }
            : prev,
        )
        toast({ title: "Widget updated" })
      }
      setWidgetForm(null)
    } catch (err) {
      setWidgetFormError(err instanceof ApiError ? err.message : "Could not save the widget.")
    } finally {
      setWidgetSubmitting(false)
    }
  }

  const removeWidget = async (widgetId: string) => {
    try {
      await apiFetch(`/api/v1/dashboards/${id}/widgets/${widgetId}`, { method: "DELETE" })
      setDashboard((prev) =>
        prev ? { ...prev, widgets: prev.widgets.filter((w) => w.id !== widgetId) } : prev,
      )
    } catch (err) {
      toast({
        title: "Could not remove widget",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setConfirmRemoveWidget(null)
    }
  }

  const persistPosition = async (widget: DashboardWidget, x: number, y: number) => {
    const cell = clampCell({ x, y }, widget.width, GRID_COLUMNS)
    if (cell.x === widget.positionX && cell.y === widget.positionY) return
    setDashboard((prev) =>
      prev
        ? {
            ...prev,
            widgets: prev.widgets.map((w) =>
              w.id === widget.id ? { ...w, positionX: cell.x, positionY: cell.y } : w,
            ),
          }
        : prev,
    )
    try {
      await apiFetch<DashboardWidget>(`/api/v1/dashboards/${id}/widgets/${widget.id}/reposition`, {
        method: "POST",
        body: { positionX: cell.x, positionY: cell.y },
      })
    } catch (err) {
      toast({
        title: "Reposition failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
      await load()
    }
  }

  const onDropWidget = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    const widget = dashboard?.widgets.find((w) => w.id === dragId)
    setDragId(null)
    if (!widget || !gridRef.current) return
    const rect = gridRef.current.getBoundingClientRect()
    const cell = pointToCell(e, rect, ROW_HEIGHT_PX, GRID_COLUMNS)
    void persistPosition(widget, cell.x, cell.y)
  }

  const nudgeWidget = (widget: DashboardWidget, dx: number, dy: number) => {
    void persistPosition(widget, widget.positionX + dx, widget.positionY + dy)
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading dashboard">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (error !== null || dashboard === null) {
    return (
      <ErrorState message={error ?? "This dashboard does not exist."} onRetry={() => void load()} />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/dashboards" className="text-sm text-muted-foreground hover:underline">
        ← Back to dashboards
      </Link>
      <RecordHeader
        title={dashboard.name}
        subtitle={dashboard.description ?? "No description"}
        actions={
          <>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setWidgetFormError(null)
                setWidgetForm(emptyWidgetForm())
              }}
            >
              Add widget
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />

      <section aria-label="Edit dashboard" className="rounded-md border border-border p-4">
        <form onSubmit={saveDetails} className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="dashboard-name">
            <TextField
              id="dashboard-name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </Field>
          <Field label="Description" htmlFor="dashboard-description">
            <TextField
              id="dashboard-description"
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </section>

      {widgetForm ? (
        <section
          aria-label={widgetForm.mode === "add" ? "Add widget" : "Edit widget"}
          className="rounded-md border border-border p-4"
        >
          <form onSubmit={submitWidgetForm} className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">
              {widgetForm.mode === "add" ? "Add widget" : "Edit widget"}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Type" htmlFor="widget-type" required>
                <Select
                  id="widget-type"
                  value={widgetForm.type}
                  onChange={(e) =>
                    setWidgetForm((f) =>
                      f ? { ...f, type: e.currentTarget.value as WidgetType } : f,
                    )
                  }
                  options={WIDGET_TYPE_OPTIONS}
                />
              </Field>
              <Field label="Title" htmlFor="widget-title" required error={widgetFormError}>
                <TextField
                  id="widget-title"
                  value={widgetForm.title}
                  onChange={(e) =>
                    setWidgetForm((f) => (f ? { ...f, title: e.currentTarget.value } : f))
                  }
                  placeholder="Open deals"
                  required
                />
              </Field>
              <Field label="Width (1-12 columns)" htmlFor="widget-width">
                <TextField
                  id="widget-width"
                  type="number"
                  min={1}
                  max={12}
                  value={widgetForm.width}
                  onChange={(e) =>
                    setWidgetForm((f) =>
                      f ? { ...f, width: Number(e.currentTarget.value) || 1 } : f,
                    )
                  }
                />
              </Field>
              <Field label="Height (rows)" htmlFor="widget-height">
                <TextField
                  id="widget-height"
                  type="number"
                  min={1}
                  max={12}
                  value={widgetForm.height}
                  onChange={(e) =>
                    setWidgetForm((f) =>
                      f ? { ...f, height: Number(e.currentTarget.value) || 1 } : f,
                    )
                  }
                />
              </Field>
            </div>
            <details>
              <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
              <div className="mt-3 flex flex-col gap-3">
                <Field
                  label="Report ID (optional)"
                  htmlFor="widget-report-id"
                  hint="Opaque id of a report from the Reports module. Not validated here."
                >
                  <TextField
                    id="widget-report-id"
                    value={widgetForm.reportId}
                    onChange={(e) =>
                      setWidgetForm((f) => (f ? { ...f, reportId: e.currentTarget.value } : f))
                    }
                  />
                </Field>
                <Field
                  label="Config (JSON, optional)"
                  htmlFor="widget-config"
                  hint='Preview data, e.g. {"value": 42, "unit": "deals"} for metric, {"series": [{"label": "Mon", "value": 3}]} for bar/line.'
                >
                  <TextArea
                    id="widget-config"
                    value={widgetForm.configText}
                    onChange={(e) =>
                      setWidgetForm((f) => (f ? { ...f, configText: e.currentTarget.value } : f))
                    }
                    rows={4}
                  />
                </Field>
              </div>
            </details>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={widgetSubmitting}>
                {widgetSubmitting
                  ? "Saving…"
                  : widgetForm.mode === "add"
                    ? "Add widget"
                    : "Save widget"}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setWidgetForm(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </section>
      ) : null}

      {dashboard.widgets.length === 0 ? (
        <EmptyState
          title="No widgets yet"
          description="Add a metric, table, bar or line widget to start visualizing this dashboard. Click “Add widget” above to place your first one — you can drag it anywhere on the grid afterwards."
          action={
            <Button
              type="button"
              onClick={() => {
                setWidgetFormError(null)
                setWidgetForm(emptyWidgetForm())
              }}
            >
              Add widget
            </Button>
          }
        />
      ) : (
        <div
          ref={gridRef}
          className="grid grid-cols-12 gap-3"
          style={{ gridAutoRows: `${ROW_HEIGHT_PX}px` }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDropWidget}
          role="list"
          aria-label="Dashboard widgets"
        >
          {dashboard.widgets.map((widget) => (
            <div
              key={widget.id}
              role="listitem"
              draggable
              onDragStart={() => setDragId(widget.id)}
              onDragEnd={() => setDragId(null)}
              style={{
                gridColumn: `${widget.positionX + 1} / span ${widget.width}`,
                gridRow: `${widget.positionY + 1} / span ${widget.height}`,
              }}
              className="flex flex-col gap-2 overflow-hidden rounded-xl border border-border bg-card p-3 shadow-panel"
              aria-label={`${widget.title} (${widget.type} widget)`}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="truncate text-sm font-semibold">{widget.title}</h3>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs"
                    onClick={() => {
                      setWidgetFormError(null)
                      setWidgetForm(widgetToForm(widget))
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs text-destructive"
                    onClick={() => setConfirmRemoveWidget(widget.id)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                <WidgetBody widget={widget} />
              </div>
              <div
                className="flex items-center gap-1"
                aria-label={`Move ${widget.title} (keyboard-accessible alternative to drag and drop)`}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 w-6 p-0 text-xs"
                  aria-label="Move left"
                  onClick={() => nudgeWidget(widget, -1, 0)}
                >
                  ←
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 w-6 p-0 text-xs"
                  aria-label="Move right"
                  onClick={() => nudgeWidget(widget, 1, 0)}
                >
                  →
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 w-6 p-0 text-xs"
                  aria-label="Move up"
                  onClick={() => nudgeWidget(widget, 0, -1)}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 w-6 p-0 text-xs"
                  aria-label="Move down"
                  onClick={() => nudgeWidget(widget, 0, 1)}
                >
                  ↓
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${dashboard.name}?`}
        description="The dashboard moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void removeDashboard()}
      />

      <ConfirmDialog
        open={confirmRemoveWidget !== null}
        onOpenChange={(open) => !open && setConfirmRemoveWidget(null)}
        title="Remove this widget?"
        description="It is removed from the dashboard immediately."
        confirmLabel="Remove"
        danger
        onConfirm={() => confirmRemoveWidget && void removeWidget(confirmRemoveWidget)}
      />
    </div>
  )
}
