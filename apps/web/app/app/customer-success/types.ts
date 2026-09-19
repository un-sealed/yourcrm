/** CS account record as returned by `GET /api/v1/customer-success/accounts` items. */
export type CsHealthFactor = {
  key: string
  label: string
  rawValue: number | null
  normalizedScore: number
  weight: number
  contribution: number
}

export type CsHealthScore = {
  id: string
  workspaceId: string
  accountId: string
  score: string
  factors: CsHealthFactor[]
  computedAt: string
  computedBy: string | null
}

export type CsAccount = {
  id: string
  workspaceId: string
  companyId: string
  ownerId: string | null
  lifecycleStage: string
  arr: string | null
  renewalDate: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
  /** Enriched by the list endpoint; null until a score has been computed. */
  latestHealthScore?: CsHealthScore | null
}

export type CsAccountListResponse = {
  data: CsAccount[]
  pagination: { nextCursor: string | null; limit: number }
}

export type CsRenewal = {
  id: string
  workspaceId: string
  accountId: string
  renewalDate: string
  arr: string | null
  ownerId: string | null
  status: string
  riskFlag: boolean
  notes: string | null
  createdAt: string
  updatedAt: string
}

export type CsRenewalListResponse = {
  data: CsRenewal[]
  pagination: { nextCursor: string | null; limit: number }
}

export type CsPlaybookCatalogEntry = {
  key: string
  label: string
  description: string
  taskCount: number
}

export type CsPlaybookTask = {
  id: string
  workspaceId: string
  accountId: string
  playbookKey: string
  taskId: string
  appliedBy: string | null
  appliedAt: string
}

export type CsPlaybookTaskList = {
  links: CsPlaybookTask[]
  tasks: { id: string; title?: string; status?: string; dueDate?: string | null }[]
}

export const CS_LIFECYCLE_STAGES = [
  "onboarding",
  "adopting",
  "healthy",
  "at_risk",
  "churned",
] as const

export const CS_LIFECYCLE_OPTIONS = [
  { value: "onboarding", label: "Onboarding" },
  { value: "adopting", label: "Adopting" },
  { value: "healthy", label: "Healthy" },
  { value: "at_risk", label: "At risk" },
  { value: "churned", label: "Churned" },
]

export function lifecycleTone(stage: string): "success" | "warning" | "destructive" | "secondary" {
  if (stage === "healthy") return "success"
  if (stage === "at_risk") return "warning"
  if (stage === "churned") return "destructive"
  return "secondary"
}

export function healthTone(score: number): "success" | "warning" | "destructive" {
  if (score >= 70) return "success"
  if (score >= 40) return "warning"
  return "destructive"
}

export function formatScore(score: string | number | null | undefined): string {
  if (score === null || score === undefined) return "—"
  const num = typeof score === "number" ? score : Number(score)
  return Number.isFinite(num) ? num.toFixed(0) : "—"
}

export function formatCurrency(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—"
  const num = Number(value)
  if (!Number.isFinite(num)) return "—"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(num)
}

export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString()
}
