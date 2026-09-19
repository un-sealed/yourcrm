import type { FilterCondition, FilterFieldDef, FilterNode, FilterTree } from "@yourcrm/ui"

/** Deal record as returned by `GET /api/v1/deals` (envelope `data` item). */
export type Deal = {
  id: string
  workspaceId: string
  name: string
  amount: string | number | null
  currency: string
  pipelineId: string | null
  stageId: string | null
  stage: string
  probability: number | null
  expectedCloseDate: string | null
  personId: string | null
  companyId: string | null
  ownerId: string | null
  closeReason: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export type DealsListResponse = {
  data: Deal[]
  pagination: { nextCursor: string | null; limit: number }
}

export const DEAL_STAGES = [
  "qualification",
  "discovery",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const

export type DealStage = (typeof DEAL_STAGES)[number]

const STAGE_LABELS: Record<DealStage, string> = {
  qualification: "Qualification",
  discovery: "Discovery",
  proposal: "Proposal",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
}

export function stageLabel(stage: string): string {
  return (STAGE_LABELS as Record<string, string>)[stage] ?? stage
}

export function amountNumber(amount: Deal["amount"]): number | null {
  if (amount === null || amount === undefined) return null
  const num = typeof amount === "number" ? amount : Number(amount)
  return Number.isFinite(num) ? num : null
}

export function formatMoney(amount: Deal["amount"], currency: string): string {
  const num = amountNumber(amount)
  if (num === null) return "—"
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(num)
  } catch {
    return `${num.toFixed(2)} ${currency}`
  }
}

/** Weighted value (amount * probability / 100), derived — never stored. */
export function weightedValue(deal: Pick<Deal, "amount" | "probability">): number | null {
  const num = amountNumber(deal.amount)
  if (num === null || deal.probability === null || deal.probability === undefined) return null
  return Math.round(num * (deal.probability / 100) * 100) / 100
}

export const DEAL_FILTER_FIELDS: FilterFieldDef[] = [
  { name: "name", label: "Name", type: "text" },
  {
    name: "stage",
    label: "Stage",
    type: "select",
    options: DEAL_STAGES.map((stage) => ({ value: stage, label: stageLabel(stage) })),
  },
]

export type { FilterTree }

export type DealsListParams = {
  query?: string
  stage?: string
}

/**
 * Map a UI `FilterTree` onto the P0 list query params (`?query=&stage=`).
 * Only `contains` leaves on the name field and `eq` leaves on `stage` have
 * server support today; anything else is ignored so the builder stays usable
 * for saved views while structured search grows.
 */
export function treeToDealsParams(tree: FilterTree): DealsListParams {
  const params: DealsListParams = {}
  const visit = (node: FilterNode): void => {
    if (node.type === "group") {
      for (const child of node.children) visit(child)
      return
    }
    const leaf = node as FilterCondition
    if (typeof leaf.value !== "string" || leaf.value.trim() === "") return
    if (leaf.field === "stage" && (leaf.operator === "eq" || leaf.operator === "in")) {
      const value = Array.isArray(leaf.value) ? leaf.value[0] : leaf.value
      if ((DEAL_STAGES as readonly string[]).includes(value)) params.stage = value
      return
    }
    if (leaf.field === "name" && (leaf.operator === "contains" || leaf.operator === "eq")) {
      params.query = params.query === undefined ? leaf.value : `${params.query} ${leaf.value}`
    }
  }
  visit(tree)
  return params
}
