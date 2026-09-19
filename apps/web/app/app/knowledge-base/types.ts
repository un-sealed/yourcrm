import type { FilterFieldDef, FilterTree } from "@yourcrm/ui"

/** Knowledge base category as returned by `GET /api/v1/knowledge-base/categories`. */
export type KbCategory = {
  id: string
  workspaceId: string
  name: string
  slug: string
  description: string | null
  createdAt: string
  updatedAt: string
}

/** Article record as returned by `GET /api/v1/knowledge-base/articles` (envelope `data` item). */
export type KbArticle = {
  id: string
  workspaceId: string
  title: string
  slug: string
  body: string
  status: "draft" | "published" | "archived"
  categoryId: string | null
  authorId: string | null
  publishedAt: string | null
  viewCount: number
  createdAt: string
  updatedAt: string
}

export type KbArticleListResponse = {
  data: KbArticle[]
  pagination: { nextCursor: string | null; limit: number }
}

export const KB_ARTICLE_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "title", label: "Title", type: "text" },
  {
    name: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "draft", label: "Draft" },
      { value: "published", label: "Published" },
      { value: "archived", label: "Archived" },
    ],
  },
]

export type { FilterTree }
