"use client"

import {
  Button,
  Field,
  FilterBuilder,
  TextArea,
  TextField,
  emptyFilterTree,
  type FilterTree,
} from "@yourcrm/ui"
import { MARKETING_SEGMENT_FILTER_FIELDS } from "./types"

/** Editable shape of a segment definition (create and edit share it). */
export type MarketingSegmentDraft = {
  name: string
  description: string
  filter: FilterTree
}

export function emptySegmentDraft(): MarketingSegmentDraft {
  return { name: "", description: "", filter: emptyFilterTree() }
}

/** Request body for POST/PATCH `/api/v1/marketing/segments`. */
export function segmentDraftToBody(draft: MarketingSegmentDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() === "" ? null : draft.description.trim(),
    filter: draft.filter,
  }
}

export interface MarketingSegmentBuilderProps {
  value: MarketingSegmentDraft
  onChange: (draft: MarketingSegmentDraft) => void
  onPreview?: () => void
  previewCount?: number | null
  previewing?: boolean
}

/**
 * Segment audience builder: name/description plus the `FilterBuilder`
 * against the person field allowlist — a marketing segment IS a saved
 * filter over people, using the one shared filter-tree model (see
 * `types.ts`).
 */
export function MarketingSegmentBuilder({
  value,
  onChange,
  onPreview,
  previewCount = null,
  previewing = false,
}: MarketingSegmentBuilderProps) {
  const patch = (next: Partial<MarketingSegmentDraft>) => onChange({ ...value, ...next })

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Segment name" htmlFor="segment-name" required>
          <TextField
            id="segment-name"
            value={value.name}
            onChange={(event) => patch({ name: event.currentTarget.value })}
            placeholder="Active customers"
            required
          />
        </Field>
      </div>

      <Field label="Description" htmlFor="segment-description">
        <TextArea
          id="segment-description"
          value={value.description}
          onChange={(event) => patch({ description: event.currentTarget.value })}
          placeholder="Who is this audience, and why?"
        />
      </Field>

      <section aria-label="Audience filter" className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Audience</h2>
          {onPreview ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={previewing}
              onClick={onPreview}
            >
              {previewing ? "Counting…" : "Preview count"}
            </Button>
          ) : null}
        </div>
        <FilterBuilder
          value={value.filter}
          onChange={(filter) => patch({ filter })}
          fields={MARKETING_SEGMENT_FILTER_FIELDS}
        />
        {previewCount !== null ? (
          <p className="text-sm text-muted-foreground">
            {previewCount} {previewCount === 1 ? "person matches" : "people match"} this filter
            right now.
          </p>
        ) : null}
      </section>
    </div>
  )
}
