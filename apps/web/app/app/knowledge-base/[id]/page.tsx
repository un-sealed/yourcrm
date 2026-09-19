"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import {
  Button,
  ConfirmDialog,
  Field,
  RecordHeader,
  Select,
  Skeleton,
  ErrorState,
  Tabs,
  TextArea,
  TextField,
  Timeline,
  toast,
} from "@yourcrm/ui"
import { ApiError, apiFetch } from "@/lib/api-client"
import type { KbArticle, KbCategory } from "../types"

const STATUS_TONE: Record<string, "secondary" | "success" | "outline"> = {
  draft: "secondary",
  published: "success",
  archived: "outline",
}

/**
 * Article detail: header with publish/unpublish/archive/delete actions,
 * read view and an edit form. `body` is Markdown SOURCE TEXT — it is
 * rendered here as plain text inside a `<pre>` (React escapes text content
 * automatically), never parsed into HTML and never passed through
 * `dangerouslySetInnerHTML`. That is a deliberate P0 scope call (see the
 * module report): no markdown/sanitizer dependency was added.
 */
export default function ArticleDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params.id
  const [article, setArticle] = useState<KbArticle | null>(null)
  const [categories, setCategories] = useState<KbCategory[]>([])
  const [tab, setTab] = useState("read")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [slug, setSlug] = useState("")
  const [categoryId, setCategoryId] = useState("")
  const [body, setBody] = useState("")
  const [saving, setSaving] = useState(false)
  const [working, setWorking] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<KbArticle>(`/api/v1/knowledge-base/articles/${id}`)
      setArticle(data)
      setTitle(data.title)
      setSlug(data.slug)
      setCategoryId(data.categoryId ?? "")
      setBody(data.body)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 404
            ? "This article does not exist, or you do not have permission to view it as a draft."
            : err.message
          : "Could not load this article.",
      )
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    apiFetch<KbCategory[]>("/api/v1/knowledge-base/categories")
      .then(setCategories)
      .catch(() => undefined)
  }, [])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const updated = await apiFetch<KbArticle>(`/api/v1/knowledge-base/articles/${id}`, {
        method: "PATCH",
        body: {
          title: title.trim(),
          slug: slug.trim(),
          body,
          categoryId: categoryId === "" ? null : categoryId,
        },
      })
      setArticle(updated)
      toast({ title: "Article updated" })
    } catch (err) {
      toast({
        title: "Update failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  const transition = async (action: "publish" | "unpublish" | "archive") => {
    setWorking(true)
    try {
      const updated = await apiFetch<KbArticle>(`/api/v1/knowledge-base/articles/${id}/${action}`, {
        method: "POST",
      })
      setArticle(updated)
      toast({ title: `Article ${action}ed` })
    } catch (err) {
      toast({
        title: `Could not ${action} article`,
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    } finally {
      setWorking(false)
    }
  }

  const remove = async () => {
    try {
      await apiFetch(`/api/v1/knowledge-base/articles/${id}`, { method: "DELETE" })
      toast({ title: "Article deleted", description: "It can be restored from trash." })
      router.push("/app/knowledge-base")
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError ? err.message : "Try again.",
      })
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading article">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (error !== null || article === null) {
    return (
      <ErrorState message={error ?? "This article does not exist."} onRetry={() => void load()} />
    )
  }

  const categoryName = categories.find((c) => c.id === article.categoryId)?.name ?? "Uncategorized"

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app/knowledge-base" className="text-sm text-muted-foreground hover:underline">
        ← Back to knowledge base
      </Link>
      <RecordHeader
        title={article.title}
        subtitle={`${categoryName} · ${article.viewCount} view${article.viewCount === 1 ? "" : "s"}`}
        status={{ label: article.status, tone: STATUS_TONE[article.status] ?? "secondary" }}
        actions={
          <>
            {article.status !== "published" ? (
              <Button size="sm" onClick={() => void transition("publish")} disabled={working}>
                Publish
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void transition("unpublish")}
                disabled={working}
              >
                Unpublish
              </Button>
            )}
            {article.status !== "archived" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void transition("archive")}
                disabled={working}
              >
                Archive
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void transition("unpublish")}
                disabled={working}
              >
                Move to draft
              </Button>
            )}
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        ariaLabel="Article sections"
        items={[
          {
            value: "read",
            label: "Read",
            content: (
              <div className="py-4">
                {article.body.trim() === "" ? (
                  <p className="text-sm text-muted-foreground">This article has no content yet.</p>
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
                    {article.body}
                  </pre>
                )}
              </div>
            ),
          },
          {
            value: "edit",
            label: "Edit",
            content: (
              <form onSubmit={save} className="flex flex-col gap-3 py-4">
                <Field label="Title" htmlFor="kb-edit-title">
                  <TextField
                    id="kb-edit-title"
                    value={title}
                    onChange={(e) => setTitle(e.currentTarget.value)}
                  />
                </Field>
                <Field
                  label="Slug"
                  htmlFor="kb-edit-slug"
                  hint="Lowercase letters, numbers and single - or _ separators. Must be unique in this workspace."
                >
                  <TextField
                    id="kb-edit-slug"
                    value={slug}
                    onChange={(e) => setSlug(e.currentTarget.value)}
                  />
                </Field>
                <Field label="Category" htmlFor="kb-edit-category">
                  <Select
                    id="kb-edit-category"
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.currentTarget.value)}
                    options={[
                      { value: "", label: "Uncategorized" },
                      ...categories.map((c) => ({ value: c.id, label: c.name })),
                    ]}
                  />
                </Field>
                <Field
                  label="Body (Markdown)"
                  htmlFor="kb-edit-body"
                  hint="Stored as plain Markdown source and displayed as plain text — no HTML is rendered."
                >
                  <TextArea
                    id="kb-edit-body"
                    value={body}
                    onChange={(e) => setBody(e.currentTarget.value)}
                    rows={14}
                  />
                </Field>
                <div>
                  <Button type="submit" disabled={saving}>
                    {saving ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              </form>
            ),
          },
          {
            value: "activity",
            label: "Activity",
            content: (
              <div className="py-4">
                <Timeline
                  items={[
                    {
                      id: "created",
                      actor: "System",
                      timestamp: new Date(article.createdAt).toLocaleString(),
                      dateTime: article.createdAt,
                      body: "Article created.",
                    },
                    ...(article.publishedAt
                      ? [
                          {
                            id: "published",
                            actor: "System",
                            timestamp: new Date(article.publishedAt).toLocaleString(),
                            dateTime: article.publishedAt,
                            body: "Article published.",
                          },
                        ]
                      : []),
                    {
                      id: "updated",
                      actor: "System",
                      timestamp: new Date(article.updatedAt).toLocaleString(),
                      dateTime: article.updatedAt,
                      body: "Article last updated.",
                    },
                  ]}
                />
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${article.title}"?`}
        description="The article moves to trash and can be restored."
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
      />
    </div>
  )
}
