"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button, Field, Select, TextArea, TextField, toast } from "@yourcrm/ui"
import { useUnsavedGuard } from "@/components/use-unsaved-guard"
import { ApiError, apiFetch } from "@/lib/api-client"
import type { KbArticle, KbCategory } from "../types"

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Create-article form: required fields first, body last. Slug is derived
 * from the title but stays editable — it is validated server-side against a
 * strict allowlist and must be unique in the workspace. */
export default function NewArticlePage() {
  const router = useRouter()
  const [title, setTitle] = useState("")
  const [slug, setSlug] = useState("")
  const [slugTouched, setSlugTouched] = useState(false)
  const [categoryId, setCategoryId] = useState("")
  const [categories, setCategories] = useState<KbCategory[]>([])
  const [body, setBody] = useState("")
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    apiFetch<KbCategory[]>("/api/v1/knowledge-base/categories")
      .then(setCategories)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!slugTouched) setSlug(slugify(title))
  }, [title, slugTouched])

  const dirty = title !== "" || body !== ""
  useUnsavedGuard(dirty && !saving)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (title.trim() === "") {
      setFieldError("Title is required.")
      return
    }
    if (slug.trim() === "") {
      setFieldError("Slug is required.")
      return
    }
    setFieldError(null)
    setSaving(true)
    try {
      const article = await apiFetch<KbArticle>("/api/v1/knowledge-base/articles", {
        method: "POST",
        body: {
          title: title.trim(),
          slug: slug.trim(),
          body,
          ...(categoryId === "" ? {} : { categoryId }),
        },
      })
      toast({ title: "Article created", description: "Saved as a draft." })
      router.push(`/app/knowledge-base/${article.id}`)
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : "Could not create the article.")
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">New article</h1>
        <Link href="/app/knowledge-base" className="text-sm text-muted-foreground hover:underline">
          Back to knowledge base
        </Link>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Title" htmlFor="kb-title" required error={fieldError}>
          <TextField
            id="kb-title"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            placeholder="How to reset your password"
            required
            invalid={fieldError !== null && title.trim() === ""}
          />
        </Field>
        <Field
          label="Slug"
          htmlFor="kb-slug"
          required
          hint="Lowercase letters, numbers and single - or _ separators. Must be unique in this workspace."
        >
          <TextField
            id="kb-slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.currentTarget.value)
              setSlugTouched(true)
            }}
            placeholder="how-to-reset-your-password"
            required
          />
        </Field>
        <Field label="Category" htmlFor="kb-category">
          <Select
            id="kb-category"
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
          htmlFor="kb-body"
          hint="Stored as plain Markdown source and displayed as plain text — no HTML is rendered."
        >
          <TextArea
            id="kb-body"
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            placeholder="## Overview&#10;&#10;Write the article here…"
            rows={14}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/app/knowledge-base")}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Create article"}
          </Button>
        </div>
      </form>
    </div>
  )
}
