"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge, Button, ConfirmDialog, ErrorState, Skeleton } from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"

type OnboardingStep = {
  key: string
  title: string
  description: string
  done: boolean
  completedAt: string | null
}

type OnboardingProgress = {
  workspaceId: string
  steps: OnboardingStep[]
  completedSteps: number
  totalSteps: number
  percentComplete: number
  dismissed: boolean
  dismissedAt: string | null
  sampleDataSeeded: boolean
  sampleDataSeededAt: string | null
}

/**
 * Guided onboarding checklist (spec 42-onboarding). Every step's `done`
 * flag comes straight from `GET /api/v1/onboarding/progress` — the server
 * derives it from real workspace data, so this component never lets the
 * user "check off" a step directly; it can only trigger real actions
 * (dismiss/reopen, seed/remove sample data) that the server re-derives
 * progress from afterwards.
 */
export function OnboardingChecklist({ compact = false }: { compact?: boolean }) {
  const [progress, setProgress] = useState<OnboardingProgress | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<OnboardingProgress>("/api/v1/onboarding/progress")
      setProgress(data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load onboarding progress.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function runAction(path: string, method: "POST" | "DELETE") {
    setWorking(true)
    setError(null)
    try {
      const data = await apiFetch<OnboardingProgress>(path, { method })
      setProgress(data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That action could not be completed.")
    } finally {
      setWorking(false)
    }
  }

  if (loading && !progress) {
    return (
      <div
        className="flex flex-col gap-3"
        aria-busy="true"
        aria-label="Loading onboarding checklist"
      >
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  if (error !== null && !progress) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  if (!progress) return null

  return (
    <div className="flex flex-col gap-4">
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {progress.completedSteps} of {progress.totalSteps} done
            </span>
            <span className="text-muted-foreground">{progress.percentComplete}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={progress.percentComplete}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Onboarding progress"
            className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${progress.percentComplete}%` }}
            />
          </div>
        </div>
        {progress.dismissed ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={working}
            onClick={() => void runAction("/api/v1/onboarding/reopen", "POST")}
          >
            Reopen checklist
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={working}
            onClick={() => void runAction("/api/v1/onboarding/dismiss", "POST")}
          >
            Dismiss
          </Button>
        )}
      </div>

      {progress.dismissed ? (
        <p className="text-xs text-muted-foreground">
          Checklist dismissed. It stays accurate in the background — reopen it any time.
        </p>
      ) : null}

      <ol className="flex flex-col gap-2">
        {progress.steps.map((step, i) => (
          <li
            key={step.key}
            className="flex items-start gap-3 rounded-md border p-3"
            data-done={step.done}
          >
            <span
              aria-hidden="true"
              className={
                "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium " +
                (step.done
                  ? "border-emerald-600 bg-emerald-600 text-white"
                  : "border-muted-foreground/40 text-muted-foreground")
              }
            >
              {step.done ? "✓" : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{step.title}</span>
                <Badge tone={step.done ? "success" : "secondary"}>
                  {step.done ? "Done" : "To do"}
                </Badge>
              </div>
              {!compact ? (
                <p className="mt-0.5 text-sm text-muted-foreground">{step.description}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {!compact ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          {progress.sampleDataSeeded ? (
            <>
              <p className="text-sm text-muted-foreground">
                Sample people and deals are in your workspace, clearly marked as demo.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={working}
                onClick={() => setConfirmRemove(true)}
              >
                Remove sample data
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={working}
              onClick={() => void runAction("/api/v1/onboarding/sample-data", "POST")}
            >
              Load sample data
            </Button>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove sample data?"
        description="Deletes the sample people and deals created for you. Your real records are never touched."
        confirmLabel="Remove"
        danger
        loading={working}
        onConfirm={() => {
          setConfirmRemove(false)
          void runAction("/api/v1/onboarding/sample-data", "DELETE")
        }}
      />
    </div>
  )
}
