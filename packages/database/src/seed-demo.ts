/**
 * Rich demo dataset for the development workspace. Run AFTER `bun run db:seed`
 * — it reuses that script's workspace and its two users rather than creating
 * its own, so every module page has coherent, clickable data and the
 * owner-scoped surfaces (reports, inbox, customer success, search) differ
 * visibly between the admin and the sales login.
 *
 * Conventions match `seed.ts`: plain `postgres` client, tagged-template SQL,
 * no ORM, fixed ids so re-running is idempotent (`ON CONFLICT DO NOTHING` —
 * the second run is a clean no-op). Every id this script writes looks like
 * `c00000NN-0000-4000-8000-<index>`, which is what `SEED_RESET=1` matches on
 * to remove the dataset again in foreign-key-safe order.
 *
 * Coverage: companies, people (+ emails/phones), pipelines + stages, deals,
 * leads, tasks, activities, tickets + comments, products + prices, quotes +
 * line items, invoices + line items + payments, kb categories + articles,
 * calendar events + attendees, notifications. The draft's speculative
 * sections (email threads, whatsapp, calls, forms, tags, campaigns,
 * sequences, customer-success, booking, AI, marketplace) are intentionally
 * NOT seeded — each needs its schema verified first, and partial coverage
 * that actually runs beats full coverage that errors.
 *
 * Usage: `bun run db:seed:demo` (or `SEED_RESET=1 bun run db:seed:demo`)
 */
import postgres from "postgres"

/** Seeded by `seed.ts`; this script never creates workspaces or users. */
const WORKSPACE = "11111111-1111-4111-8111-111111111111"
const ADMIN = "22222222-2222-4222-8222-222222222222"
const SALES = "33333333-3333-4333-8333-333333333333"

type Owner = "admin" | "sales"

function userId(owner: Owner): string {
  return owner === "admin" ? ADMIN : SALES
}

/**
 * Id namespaces. Every demo row is `<group>-0000-4000-8000-<12-digit index>`,
 * a valid v4-shaped uuid that no other seed or fixture uses.
 */
const GROUPS = {
  company: "c0000001",
  person: "c0000002",
  personEmail: "c0000003",
  personPhone: "c0000004",
  lead: "c0000005",
  pipeline: "c0000006",
  stage: "c0000007",
  deal: "c0000008",
  activity: "c0000009",
  task: "c000000a",
  product: "c000000b",
  price: "c000000c",
  quote: "c000000d",
  quoteItem: "c000000e",
  invoice: "c000000f",
  invoiceItem: "c0000010",
  payment: "c0000011",
  ticket: "c0000012",
  ticketComment: "c0000013",
  kbCategory: "c0000014",
  kbArticle: "c0000015",
  calendarEvent: "c000001f",
  calendarAttendee: "c0000020",
  notification: "c000002d",
} as const

type Group = keyof typeof GROUPS

function id(group: Group, index: number): string {
  return `${GROUPS[group]}-0000-4000-8000-${String(index).padStart(12, "0")}`
}

/** Matches every id above and nothing the foundation seed or a user writes. */
const DEMO_ID_PATTERN = "c00000%-0000-4000-8000-%"

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** Clock anchored on the database's `now()`, so nothing is hardcoded to a year. */
type Clock = {
  /** Timestamp `days` from now, at `hour` UTC (defaults to 10:00). */
  at: (days: number, hour?: number) => Date
  /** `YYYY-MM-DD` for a `date` column, `days` from now. */
  day: (days: number) => string
}

function makeClock(now: Date): Clock {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return {
    at: (days, hour = 10) => new Date(midnight + days * DAY_MS + hour * HOUR_MS),
    day: (days) => new Date(midnight + days * DAY_MS).toISOString().slice(0, 10),
  }
}

/* ------------------------------- companies -------------------------------- */

type CompanySeed = {
  name: string
  domain: string
  industry: string
  size: string
  owner: Owner
  description: string
}

const COMPANIES: readonly CompanySeed[] = [
  {
    name: "Northwind Logistics",
    domain: "northwindlogistics.com",
    industry: "Logistics & Supply Chain",
    size: "500-1000",
    owner: "admin",
    description: "Regional freight and last-mile carrier running a 900-vehicle fleet.",
  },
  {
    name: "Helios Energy Group",
    domain: "heliosenergy.com",
    industry: "Renewable Energy",
    size: "1000-5000",
    owner: "sales",
    description: "Utility-scale solar and storage developer with field crews in eleven states.",
  },
  {
    name: "Cascade Health Systems",
    domain: "cascadehealth.org",
    industry: "Healthcare",
    size: "5000+",
    owner: "admin",
    description: "Non-profit hospital network of fourteen sites and forty outpatient clinics.",
  },
  {
    name: "Brightline Retail",
    domain: "brightlineretail.com",
    industry: "Retail",
    size: "200-500",
    owner: "sales",
    description: "Omnichannel homeware retailer, 64 stores plus a growing online business.",
  },
  {
    name: "Ironvale Manufacturing",
    domain: "ironvale.com",
    industry: "Industrial Manufacturing",
    size: "500-1000",
    owner: "admin",
    description: "Precision metal components for automotive and aerospace tier-one suppliers.",
  },
  {
    name: "Meridian Financial",
    domain: "meridianfinancial.com",
    industry: "Financial Services",
    size: "1000-5000",
    owner: "sales",
    description: "Wealth management and commercial lending across three regional markets.",
  },
  {
    name: "Alpine Software Works",
    domain: "alpinesoftware.io",
    industry: "Software",
    size: "50-200",
    owner: "admin",
    description: "Developer-tools vendor; an early adopter and a frequent integration partner.",
  },
  {
    name: "Verdant Agritech",
    domain: "verdantagritech.com",
    industry: "Agriculture Technology",
    size: "50-200",
    owner: "sales",
    description: "Precision-farming sensors and agronomy services for row-crop growers.",
  },
]

function companyId(index: number): string {
  return id("company", index)
}

/* --------------------------------- people --------------------------------- */

type PersonSeed = {
  first: string
  last: string
  title: string
  company: number
  owner: Owner
  local: string
  phone: string
  channel: "email" | "phone" | "sms" | "whatsapp"
}

const PEOPLE: readonly PersonSeed[] = [
  {
    first: "Dana",
    last: "Whitfield",
    title: "VP Operations",
    company: 1,
    owner: "admin",
    local: "dana.whitfield",
    phone: "+1-415-555-0101",
    channel: "email",
  },
  {
    first: "Marcus",
    last: "Feld",
    title: "Director of Logistics",
    company: 1,
    owner: "admin",
    local: "marcus.feld",
    phone: "+1-415-555-0102",
    channel: "phone",
  },
  {
    first: "Priya",
    last: "Raghavan",
    title: "Procurement Lead",
    company: 1,
    owner: "sales",
    local: "priya.raghavan",
    phone: "+1-415-555-0103",
    channel: "email",
  },
  {
    first: "Elena",
    last: "Sorokin",
    title: "Head of Digital",
    company: 2,
    owner: "sales",
    local: "elena.sorokin",
    phone: "+1-503-555-0110",
    channel: "email",
  },
  {
    first: "Tomas",
    last: "Bergman",
    title: "Chief Technology Officer",
    company: 2,
    owner: "sales",
    local: "tomas.bergman",
    phone: "+1-503-555-0111",
    channel: "phone",
  },
  {
    first: "Ingrid",
    last: "Halvorsen",
    title: "Sustainability Manager",
    company: 2,
    owner: "admin",
    local: "ingrid.halvorsen",
    phone: "+1-503-555-0112",
    channel: "email",
  },
  {
    first: "Alan",
    last: "Reyes",
    title: "Chief Information Officer",
    company: 3,
    owner: "admin",
    local: "alan.reyes",
    phone: "+1-206-555-0120",
    channel: "email",
  },
  {
    first: "Bethany",
    last: "Cole",
    title: "Clinical Systems Manager",
    company: 3,
    owner: "admin",
    local: "bethany.cole",
    phone: "+1-206-555-0121",
    channel: "phone",
  },
  {
    first: "Jordan",
    last: "Pike",
    title: "Ecommerce Director",
    company: 4,
    owner: "sales",
    local: "jordan.pike",
    phone: "+1-312-555-0130",
    channel: "email",
  },
  {
    first: "Sofia",
    last: "Marchetti",
    title: "Head of Customer Experience",
    company: 4,
    owner: "sales",
    local: "sofia.marchetti",
    phone: "+1-312-555-0131",
    channel: "whatsapp",
  },
  {
    first: "Wes",
    last: "Okafor",
    title: "Store Operations Manager",
    company: 4,
    owner: "admin",
    local: "wes.okafor",
    phone: "+1-312-555-0132",
    channel: "phone",
  },
  {
    first: "Hannah",
    last: "Lindqvist",
    title: "Plant Manager",
    company: 5,
    owner: "admin",
    local: "hannah.lindqvist",
    phone: "+1-216-555-0140",
    channel: "email",
  },
  {
    first: "Rafael",
    last: "Duarte",
    title: "Head of Quality",
    company: 5,
    owner: "admin",
    local: "rafael.duarte",
    phone: "+1-216-555-0141",
    channel: "email",
  },
  {
    first: "Nadia",
    last: "Haddad",
    title: "Chief Operating Officer",
    company: 6,
    owner: "sales",
    local: "nadia.haddad",
    phone: "+1-617-555-0150",
    channel: "email",
  },
  {
    first: "Peter",
    last: "Vance",
    title: "Head of Compliance",
    company: 6,
    owner: "sales",
    local: "peter.vance",
    phone: "+1-617-555-0151",
    channel: "email",
  },
  {
    first: "Grace",
    last: "Lin",
    title: "Data Platform Lead",
    company: 6,
    owner: "admin",
    local: "grace.lin",
    phone: "+1-617-555-0152",
    channel: "phone",
  },
  {
    first: "Oliver",
    last: "Kestrel",
    title: "VP Engineering",
    company: 7,
    owner: "admin",
    local: "oliver.kestrel",
    phone: "+1-720-555-0160",
    channel: "email",
  },
  {
    first: "Maya",
    last: "Ortiz",
    title: "Product Lead",
    company: 7,
    owner: "sales",
    local: "maya.ortiz",
    phone: "+1-720-555-0161",
    channel: "email",
  },
  {
    first: "Samuel",
    last: "Adeyemi",
    title: "Director of Farm Technology",
    company: 8,
    owner: "sales",
    local: "samuel.adeyemi",
    phone: "+1-559-555-0170",
    channel: "whatsapp",
  },
  {
    first: "Chloe",
    last: "Barrett",
    title: "Field Operations Manager",
    company: 8,
    owner: "sales",
    local: "chloe.barrett",
    phone: "+1-559-555-0171",
    channel: "email",
  },
]

function personId(index: number): string {
  return id("person", index)
}

function leadId(index: number): string {
  return id("lead", index)
}

function personEmail(index: number): string {
  const person = PEOPLE[index - 1]
  if (person === undefined) throw new Error(`no demo person at index ${index}`)
  const company = COMPANIES[person.company - 1]
  if (company === undefined) throw new Error(`no demo company at index ${person.company}`)
  return `${person.local}@${company.domain}`
}

function personName(index: number): string {
  const person = PEOPLE[index - 1]
  if (person === undefined) throw new Error(`no demo person at index ${index}`)
  return `${person.first} ${person.last}`
}

/* -------------------------------- pipelines ------------------------------- */

type PipelineSeed = { name: string; description: string; isDefault: boolean; owner: Owner }

const PIPELINES: readonly PipelineSeed[] = [
  {
    name: "Sales Pipeline",
    description: "Default sales process: prospect to close.",
    isDefault: true,
    owner: "admin",
  },
  {
    name: "Renewal Pipeline",
    description: "Existing-customer renewals, expansions and churn.",
    isDefault: false,
    owner: "sales",
  },
]

type StageSeed = {
  index: number
  pipeline: number
  name: string
  color: string
  position: number
  probability: number
  isWon: boolean
  isLost: boolean
}

const STAGES: readonly StageSeed[] = [
  {
    index: 1,
    pipeline: 1,
    name: "Qualification",
    color: "#64748b",
    position: 0,
    probability: 10,
    isWon: false,
    isLost: false,
  },
  {
    index: 2,
    pipeline: 1,
    name: "Discovery",
    color: "#0ea5e9",
    position: 1,
    probability: 25,
    isWon: false,
    isLost: false,
  },
  {
    index: 3,
    pipeline: 1,
    name: "Proposal",
    color: "#6366f1",
    position: 2,
    probability: 50,
    isWon: false,
    isLost: false,
  },
  {
    index: 4,
    pipeline: 1,
    name: "Negotiation",
    color: "#f59e0b",
    position: 3,
    probability: 75,
    isWon: false,
    isLost: false,
  },
  {
    index: 5,
    pipeline: 1,
    name: "Closed Won",
    color: "#16a34a",
    position: 4,
    probability: 100,
    isWon: true,
    isLost: false,
  },
  {
    index: 6,
    pipeline: 1,
    name: "Closed Lost",
    color: "#dc2626",
    position: 5,
    probability: 0,
    isWon: false,
    isLost: true,
  },
  {
    index: 7,
    pipeline: 2,
    name: "Renewal Outreach",
    color: "#64748b",
    position: 0,
    probability: 20,
    isWon: false,
    isLost: false,
  },
  {
    index: 8,
    pipeline: 2,
    name: "Commercials",
    color: "#6366f1",
    position: 1,
    probability: 55,
    isWon: false,
    isLost: false,
  },
  {
    index: 9,
    pipeline: 2,
    name: "Committed",
    color: "#f59e0b",
    position: 2,
    probability: 85,
    isWon: false,
    isLost: false,
  },
  {
    index: 10,
    pipeline: 2,
    name: "Renewed",
    color: "#16a34a",
    position: 3,
    probability: 100,
    isWon: true,
    isLost: false,
  },
  {
    index: 11,
    pipeline: 2,
    name: "Churned",
    color: "#dc2626",
    position: 4,
    probability: 0,
    isWon: false,
    isLost: true,
  },
]

function stageProbability(stageIndex: number): number {
  const stage = STAGES.find((s) => s.index === stageIndex)
  if (stage === undefined) throw new Error(`no demo stage at index ${stageIndex}`)
  return stage.probability
}

/* ---------------------------------- deals --------------------------------- */

type DealStage = "qualification" | "discovery" | "proposal" | "negotiation" | "won" | "lost"

type DealSeed = {
  name: string
  amount: number
  pipeline: number
  stageIndex: number
  stage: DealStage
  owner: Owner
  person: number
  closeInDays: number
  createdDaysAgo: number
  closeReason: string | null
  notes: string
}

const DEALS: readonly DealSeed[] = [
  {
    name: "Northwind Logistics — Fleet Telematics Rollout",
    amount: 184000,
    pipeline: 1,
    stageIndex: 3,
    stage: "proposal",
    owner: "admin",
    person: 1,
    closeInDays: 21,
    createdDaysAgo: 54,
    closeReason: null,
    notes: "Proposal covers 900 vehicles in three waves. Procurement wants a phased invoice plan.",
  },
  {
    name: "Helios Energy — Field Service Platform",
    amount: 96500,
    pipeline: 1,
    stageIndex: 2,
    stage: "discovery",
    owner: "sales",
    person: 4,
    closeInDays: 35,
    createdDaysAgo: 31,
    closeReason: null,
    notes:
      "Discovery workshops booked with the crew scheduling team; offline mode is the deciding feature.",
  },
  {
    name: "Cascade Health — Patient Outreach Suite",
    amount: 242000,
    pipeline: 1,
    stageIndex: 4,
    stage: "negotiation",
    owner: "admin",
    person: 7,
    closeInDays: 12,
    createdDaysAgo: 88,
    closeReason: null,
    notes: "Legal reviewing the BAA. Pricing agreed at 1,400 seats with a two-year commitment.",
  },
  {
    name: "Brightline Retail — Omnichannel CX Upgrade",
    amount: 78400,
    pipeline: 1,
    stageIndex: 1,
    stage: "qualification",
    owner: "sales",
    person: 9,
    closeInDays: 48,
    createdDaysAgo: 11,
    closeReason: null,
    notes: "Inbound from the demo form. Budget confirmed for next fiscal quarter, not this one.",
  },
  {
    name: "Ironvale Manufacturing — Shop Floor Analytics",
    amount: 131000,
    pipeline: 1,
    stageIndex: 3,
    stage: "proposal",
    owner: "admin",
    person: 12,
    closeInDays: 26,
    createdDaysAgo: 47,
    closeReason: null,
    notes: "Pilot on line 4 went well; proposal extends to all six lines plus the Toledo plant.",
  },
  {
    name: "Meridian Financial — Client Onboarding Automation",
    amount: 205000,
    pipeline: 1,
    stageIndex: 4,
    stage: "negotiation",
    owner: "sales",
    person: 14,
    closeInDays: 9,
    createdDaysAgo: 72,
    closeReason: null,
    notes: "Security review cleared. Remaining gap is the data-residency clause in schedule 2.",
  },
  {
    name: "Alpine Software — Partner Portal Integration",
    amount: 54000,
    pipeline: 1,
    stageIndex: 2,
    stage: "discovery",
    owner: "admin",
    person: 17,
    closeInDays: 40,
    createdDaysAgo: 19,
    closeReason: null,
    notes: "They want to publish their own marketplace app alongside the integration.",
  },
  {
    name: "Verdant Agritech — Yield Forecasting Pilot",
    amount: 42750,
    pipeline: 1,
    stageIndex: 1,
    stage: "qualification",
    owner: "sales",
    person: 19,
    closeInDays: 55,
    createdDaysAgo: 6,
    closeReason: null,
    notes: "Converted from an inbound WhatsApp enquiry. Pilot scoped to 4,000 acres.",
  },
  {
    name: "Brightline Retail — Loyalty Programme Launch",
    amount: 118900,
    pipeline: 1,
    stageIndex: 5,
    stage: "won",
    owner: "sales",
    person: 10,
    closeInDays: -14,
    createdDaysAgo: 96,
    closeReason: "Chosen over two competitors on time-to-launch",
    notes: "Signed. Kickoff complete, implementation invoice already paid.",
  },
  {
    name: "Helios Energy — Legacy CRM Migration",
    amount: 89000,
    pipeline: 1,
    stageIndex: 6,
    stage: "lost",
    owner: "admin",
    person: 5,
    closeInDays: -28,
    createdDaysAgo: 120,
    closeReason: "Incumbent vendor discounted heavily at renewal",
    notes: "Revisit in two quarters — their contract ends then and the team liked the product.",
  },
  {
    name: "Northwind Logistics — Annual Renewal",
    amount: 96000,
    pipeline: 2,
    stageIndex: 8,
    stage: "proposal",
    owner: "admin",
    person: 2,
    closeInDays: 30,
    createdDaysAgo: 40,
    closeReason: null,
    notes: "Uplift of 6% agreed in principle; awaiting signature from the VP Operations.",
  },
  {
    name: "Cascade Health — Enterprise Renewal",
    amount: 310000,
    pipeline: 2,
    stageIndex: 9,
    stage: "negotiation",
    owner: "sales",
    person: 8,
    closeInDays: 18,
    createdDaysAgo: 60,
    closeReason: null,
    notes: "Committed verbally. Purchase order expected two weeks before the renewal date.",
  },
  {
    name: "Meridian Financial — Seat Expansion",
    amount: 64500,
    pipeline: 2,
    stageIndex: 7,
    stage: "qualification",
    owner: "admin",
    person: 15,
    closeInDays: 62,
    createdDaysAgo: 8,
    closeReason: null,
    notes: "Compliance team wants 120 more seats once the onboarding project lands.",
  },
  {
    name: "Alpine Software — Annual Renewal",
    amount: 28000,
    pipeline: 2,
    stageIndex: 10,
    stage: "won",
    owner: "sales",
    person: 18,
    closeInDays: -7,
    createdDaysAgo: 51,
    closeReason: "Renewed early with a 12-month extension",
    notes: "Renewed without negotiation. Good reference account for the partner programme.",
  },
  {
    name: "Ironvale Manufacturing — Renewal",
    amount: 52000,
    pipeline: 2,
    stageIndex: 11,
    stage: "lost",
    owner: "admin",
    person: 13,
    closeInDays: -21,
    createdDaysAgo: 110,
    closeReason: "Capital freeze across the group",
    notes: "Churned on budget, not on product. Shop-floor analytics deal is still live separately.",
  },
]

function dealId(index: number): string {
  return id("deal", index)
}

/** Company for a deal, resolved through its contact person. */
function dealCompany(dealIndex: number): number {
  const deal = DEALS[dealIndex - 1]
  if (deal === undefined) throw new Error(`no demo deal at index ${dealIndex}`)
  const person = PEOPLE[deal.person - 1]
  if (person === undefined) throw new Error(`no demo person at index ${deal.person}`)
  return person.company
}

/* ---------------------------------- leads --------------------------------- */

type LeadSeed = {
  first: string
  last: string
  company: string
  title: string
  email: string
  phone: string
  source: string
  status: string
  score: number
  owner: Owner
  daysAgo: number
  notes: string
}

const LEADS: readonly LeadSeed[] = [
  {
    first: "Ravi",
    last: "Menon",
    company: "Trellis Grocers",
    title: "Head of Supply",
    email: "ravi.menon@trellisgrocers.com",
    phone: "+1-206-555-0210",
    source: "form",
    status: "new",
    score: 45,
    owner: "admin",
    daysAgo: 2,
    notes: "Requested a demo of route planning after reading the logistics case study.",
  },
  {
    first: "Karin",
    last: "Voss",
    company: "Nordholt Shipping",
    title: "Operations Manager",
    email: "karin.voss@nordholt.example",
    phone: "+49-30-5550-221",
    source: "manual",
    status: "working",
    score: 60,
    owner: "sales",
    daysAgo: 9,
    notes: "Met at the logistics expo. Evaluating three vendors, decision in the autumn.",
  },
  {
    first: "Daniel",
    last: "Osei",
    company: "Kettleworth Brewing",
    title: "Commercial Director",
    email: "daniel.osei@kettleworth.example",
    phone: "+44-161-555-0232",
    source: "google",
    status: "qualified",
    score: 78,
    owner: "admin",
    daysAgo: 17,
    notes: "Budget and authority confirmed. Wants a pilot across 40 trade accounts.",
  },
  {
    first: "Amara",
    last: "Nwosu",
    company: "Silverpine Hotels",
    title: "Guest Experience Lead",
    email: "amara.nwosu@silverpinehotels.example",
    phone: "+1-305-555-0240",
    source: "meta",
    status: "new",
    score: 30,
    owner: "sales",
    daysAgo: 1,
    notes: "Clicked through from a paid social campaign; no discovery call yet.",
  },
  {
    first: "Felix",
    last: "Toth",
    company: "Granite Peak Mining",
    title: "IT Manager",
    email: "felix.toth@granitepeak.example",
    phone: "+1-406-555-0251",
    source: "whatsapp",
    status: "working",
    score: 52,
    owner: "admin",
    daysAgo: 6,
    notes: "Asked about offline-capable mobile forms for remote sites.",
  },
  {
    first: "Lucia",
    last: "Ferrara",
    company: "Casa Verde Foods",
    title: "Marketing Manager",
    email: "lucia.ferrara@casaverde.example",
    phone: "+39-02-5550-262",
    source: "form",
    status: "unqualified",
    score: 15,
    owner: "sales",
    daysAgo: 24,
    notes: "Team of four, no CRM budget this year. Added to the nurture segment.",
  },
  {
    first: "Owen",
    last: "Blackwood",
    company: "Hartline Insurance",
    title: "Broker Network Lead",
    email: "owen.blackwood@hartline.example",
    phone: "+1-402-555-0270",
    source: "indiamart",
    status: "new",
    score: 25,
    owner: "admin",
    daysAgo: 4,
    notes: "Directory enquiry. Needs qualification before anything else.",
  },
  {
    first: "Mei",
    last: "Tanaka",
    company: "Aoki Precision Tools",
    title: "General Manager",
    email: "mei.tanaka@aokiprecision.example",
    phone: "+81-3-5550-0281",
    source: "manual",
    status: "qualified",
    score: 81,
    owner: "sales",
    daysAgo: 13,
    notes: "Referred by Ironvale. Same shop-floor analytics use case, ready to scope.",
  },
  {
    first: "Tobias",
    last: "Krause",
    company: "Rheinmark Logistics",
    title: "Head of Fleet",
    email: "tobias.krause@rheinmark.example",
    phone: "+49-221-5550-292",
    source: "google",
    status: "working",
    score: 58,
    owner: "admin",
    daysAgo: 11,
    notes: "Comparing telematics integrations; sent the Northwind reference.",
  },
  {
    first: "Chloe",
    last: "Barrett",
    company: "Verdant Agritech",
    title: "Field Operations Manager",
    email: "chloe.barrett@verdantagritech.com",
    phone: "+1-559-555-0171",
    source: "justdial",
    status: "converted",
    score: 90,
    owner: "sales",
    daysAgo: 30,
    notes: "Converted into the Verdant Agritech account alongside the yield forecasting pilot.",
  },
]

/* ------------------------------- activities ------------------------------- */

type ActivitySeed = {
  title: string
  type: "note" | "call" | "meeting" | "email"
  subjectType: "person" | "company" | "deal" | "lead"
  subjectIndex: number
  owner: Owner
  status: "open" | "completed" | "cancelled"
  days: number
  body: string
}

const ACTIVITIES: readonly ActivitySeed[] = [
  {
    title: "Discovery call with VP Operations",
    type: "call",
    subjectType: "deal",
    subjectIndex: 1,
    owner: "admin",
    status: "completed",
    days: -40,
    body: "Walked through the three-wave rollout. Dana wants telemetry live before peak season.",
  },
  {
    title: "Sent fleet telematics proposal",
    type: "email",
    subjectType: "deal",
    subjectIndex: 1,
    owner: "admin",
    status: "completed",
    days: -9,
    body: "Proposal v2 sent with the phased invoice plan procurement asked for.",
  },
  {
    title: "Chase proposal feedback",
    type: "call",
    subjectType: "deal",
    subjectIndex: 1,
    owner: "admin",
    status: "open",
    days: 2,
    body: "Dana promised a decision after the operations board meets.",
  },
  {
    title: "Crew scheduling workshop",
    type: "meeting",
    subjectType: "deal",
    subjectIndex: 2,
    owner: "sales",
    status: "completed",
    days: -12,
    body: "Offline mode demoed on a tablet with airplane mode on; that landed well.",
  },
  {
    title: "Follow up on integration questions",
    type: "email",
    subjectType: "deal",
    subjectIndex: 2,
    owner: "sales",
    status: "open",
    days: 3,
    body: "Tomas asked how the SCADA export maps onto custom objects.",
  },
  {
    title: "Security questionnaire returned",
    type: "note",
    subjectType: "deal",
    subjectIndex: 3,
    owner: "admin",
    status: "completed",
    days: -21,
    body: "All 118 questions answered; two follow-ups on audit log retention.",
  },
  {
    title: "Contract redlines review",
    type: "meeting",
    subjectType: "deal",
    subjectIndex: 3,
    owner: "admin",
    status: "open",
    days: 1,
    body: "Legal on both sides joining to close out the BAA wording.",
  },
  {
    title: "Qualification call",
    type: "call",
    subjectType: "deal",
    subjectIndex: 4,
    owner: "sales",
    status: "completed",
    days: -8,
    body: "Budget lands next quarter. Keep warm with the loyalty launch story.",
  },
  {
    title: "Shop floor pilot readout",
    type: "meeting",
    subjectType: "deal",
    subjectIndex: 5,
    owner: "admin",
    status: "completed",
    days: -16,
    body: "Line 4 scrap rate down 11% over six weeks. Hannah will sponsor the rollout.",
  },
  {
    title: "Send Toledo plant addendum",
    type: "email",
    subjectType: "deal",
    subjectIndex: 5,
    owner: "admin",
    status: "open",
    days: 4,
    body: "Addendum needs the second site's seat count before it goes out.",
  },
  {
    title: "Data residency clause discussion",
    type: "call",
    subjectType: "deal",
    subjectIndex: 6,
    owner: "sales",
    status: "completed",
    days: -4,
    body: "Nadia will accept an EU-hosted option if it is contractually guaranteed.",
  },
  {
    title: "Final commercial review",
    type: "meeting",
    subjectType: "deal",
    subjectIndex: 6,
    owner: "sales",
    status: "open",
    days: 5,
    body: "Last step before signature; bring the revised schedule 2.",
  },
  {
    title: "Partner portal scoping",
    type: "meeting",
    subjectType: "deal",
    subjectIndex: 7,
    owner: "admin",
    status: "completed",
    days: -6,
    body: "Alpine want to ship a marketplace app as part of the same launch.",
  },
  {
    title: "Pilot acreage confirmed",
    type: "note",
    subjectType: "deal",
    subjectIndex: 8,
    owner: "sales",
    status: "completed",
    days: -3,
    body: "4,000 acres across two farms, sensors already installed.",
  },
  {
    title: "Loyalty launch retrospective",
    type: "meeting",
    subjectType: "deal",
    subjectIndex: 9,
    owner: "sales",
    status: "completed",
    days: -10,
    body: "Launched two weeks early. Sofia agreed to a public case study.",
  },
  {
    title: "Loss review — Helios migration",
    type: "note",
    subjectType: "deal",
    subjectIndex: 10,
    owner: "admin",
    status: "completed",
    days: -27,
    body: "Lost on price at renewal. Diarise a revisit in two quarters.",
  },
  {
    title: "Renewal uplift conversation",
    type: "call",
    subjectType: "deal",
    subjectIndex: 11,
    owner: "admin",
    status: "completed",
    days: -13,
    body: "6% uplift accepted verbally by Marcus, signature pending.",
  },
  {
    title: "Purchase order chase",
    type: "email",
    subjectType: "deal",
    subjectIndex: 12,
    owner: "sales",
    status: "open",
    days: 6,
    body: "Finance said the PO raises two weeks before the renewal date.",
  },
  {
    title: "Seat expansion discovery",
    type: "call",
    subjectType: "deal",
    subjectIndex: 13,
    owner: "admin",
    status: "open",
    days: 8,
    body: "Understand which compliance workflows the extra 120 seats cover.",
  },
  {
    title: "Renewal confirmation sent",
    type: "email",
    subjectType: "deal",
    subjectIndex: 14,
    owner: "sales",
    status: "completed",
    days: -7,
    body: "Twelve-month extension countersigned and filed.",
  },
  {
    title: "Churn debrief with quality lead",
    type: "call",
    subjectType: "deal",
    subjectIndex: 15,
    owner: "admin",
    status: "completed",
    days: -19,
    body: "Capital freeze across the group; product feedback was positive.",
  },
  {
    title: "Intro email to procurement",
    type: "email",
    subjectType: "person",
    subjectIndex: 3,
    owner: "sales",
    status: "completed",
    days: -22,
    body: "Shared the security overview and the standard MSA.",
  },
  {
    title: "Quarterly check-in",
    type: "meeting",
    subjectType: "company",
    subjectIndex: 3,
    owner: "admin",
    status: "open",
    days: 9,
    body: "Standing QBR with the Cascade Health programme office.",
  },
  {
    title: "Store operations walkthrough",
    type: "meeting",
    subjectType: "company",
    subjectIndex: 4,
    owner: "sales",
    status: "completed",
    days: -18,
    body: "Visited two flagship stores with Wes to watch checkout in practice.",
  },
  {
    title: "Voicemail left for IT manager",
    type: "call",
    subjectType: "lead",
    subjectIndex: 5,
    owner: "admin",
    status: "completed",
    days: -5,
    body: "Left a message about offline-capable mobile forms; try again midweek.",
  },
  {
    title: "Nurture email sequence started",
    type: "email",
    subjectType: "lead",
    subjectIndex: 6,
    owner: "sales",
    status: "completed",
    days: -23,
    body: "Enrolled in the small-business nurture track after disqualification.",
  },
  {
    title: "Qualify the directory enquiry",
    type: "call",
    subjectType: "lead",
    subjectIndex: 7,
    owner: "admin",
    status: "open",
    days: 1,
    body: "No company size or budget captured yet.",
  },
  {
    title: "Reference call with Ironvale",
    type: "call",
    subjectType: "lead",
    subjectIndex: 8,
    owner: "sales",
    status: "completed",
    days: -2,
    body: "Mei spoke to Rafael at Ironvale; the referral is warm.",
  },
  {
    title: "Cancelled: onsite visit",
    type: "meeting",
    subjectType: "lead",
    subjectIndex: 9,
    owner: "admin",
    status: "cancelled",
    days: -1,
    body: "Tobias postponed; his fleet audit overran.",
  },
  {
    title: "Welcome call after conversion",
    type: "call",
    subjectType: "person",
    subjectIndex: 20,
    owner: "sales",
    status: "completed",
    days: -28,
    body: "Handed Chloe over to the customer success team for onboarding.",
  },
]

function activitySubjectId(a: ActivitySeed): string {
  switch (a.subjectType) {
    case "person":
      return personId(a.subjectIndex)
    case "company":
      return companyId(a.subjectIndex)
    case "deal":
      return dealId(a.subjectIndex)
    case "lead":
      return leadId(a.subjectIndex)
  }
}

/* --------------------------------- tasks ---------------------------------- */

type TaskSeed = {
  title: string
  status: "open" | "in_progress" | "completed" | "archived"
  priority: "low" | "medium" | "high" | "urgent"
  owner: Owner
  assignee: Owner
  dueInDays: number
  deal: number | null
  person: number | null
  company: number | null
  description: string
}

const TASKS: readonly TaskSeed[] = [
  {
    title: "Send revised Northwind proposal to procurement",
    status: "open",
    priority: "high",
    owner: "admin",
    assignee: "admin",
    dueInDays: -4,
    deal: 1,
    person: 3,
    company: 1,
    description: "Overdue — procurement asked for the phased invoice plan last week.",
  },
  {
    title: "Collect Cascade Health BAA signature",
    status: "in_progress",
    priority: "urgent",
    owner: "admin",
    assignee: "admin",
    dueInDays: -1,
    deal: 3,
    person: 7,
    company: 3,
    description: "Legal returned redlines; both sides agreed the wording on the call.",
  },
  {
    title: "Prepare Meridian schedule 2 rewrite",
    status: "open",
    priority: "urgent",
    owner: "sales",
    assignee: "sales",
    dueInDays: -2,
    deal: 6,
    person: 14,
    company: 6,
    description: "Overdue — the data-residency clause is the last open item.",
  },
  {
    title: "Book Ironvale Toledo site survey",
    status: "open",
    priority: "medium",
    owner: "admin",
    assignee: "admin",
    dueInDays: 3,
    deal: 5,
    person: 12,
    company: 5,
    description: "Needed before the addendum can name a seat count.",
  },
  {
    title: "Qualify Brightline budget timing",
    status: "open",
    priority: "medium",
    owner: "sales",
    assignee: "sales",
    dueInDays: 5,
    deal: 4,
    person: 9,
    company: 4,
    description: "Confirm whether any spend can be pulled into this quarter.",
  },
  {
    title: "Draft Verdant pilot success criteria",
    status: "open",
    priority: "high",
    owner: "sales",
    assignee: "sales",
    dueInDays: 2,
    deal: 8,
    person: 19,
    company: 8,
    description: "Three measurable outcomes over the 4,000-acre pilot.",
  },
  {
    title: "Share Helios offline-mode demo recording",
    status: "completed",
    priority: "low",
    owner: "sales",
    assignee: "sales",
    dueInDays: -11,
    deal: 2,
    person: 4,
    company: 2,
    description: "Sent to the crew scheduling team after the workshop.",
  },
  {
    title: "Write Brightline loyalty case study brief",
    status: "open",
    priority: "low",
    owner: "sales",
    assignee: "sales",
    dueInDays: 12,
    deal: 9,
    person: 10,
    company: 4,
    description: "Sofia agreed to be quoted; marketing needs a one-page brief.",
  },
  {
    title: "Diarise Helios revisit after competitor renewal",
    status: "open",
    priority: "low",
    owner: "admin",
    assignee: "admin",
    dueInDays: 21,
    deal: 10,
    person: 5,
    company: 2,
    description: "Their incumbent contract ends in two quarters.",
  },
  {
    title: "Chase Northwind renewal signature",
    status: "open",
    priority: "high",
    owner: "admin",
    assignee: "admin",
    dueInDays: 1,
    deal: 11,
    person: 2,
    company: 1,
    description: "Uplift agreed verbally; needs the VP Operations signature.",
  },
  {
    title: "Confirm Cascade renewal purchase order",
    status: "open",
    priority: "high",
    owner: "sales",
    assignee: "sales",
    dueInDays: 7,
    deal: 12,
    person: 8,
    company: 3,
    description: "Finance raises the PO two weeks before the renewal date.",
  },
  {
    title: "Scope Meridian compliance seat expansion",
    status: "open",
    priority: "medium",
    owner: "admin",
    assignee: "admin",
    dueInDays: 14,
    deal: 13,
    person: 15,
    company: 6,
    description: "Which workflows do the extra 120 seats actually cover?",
  },
  {
    title: "File Alpine renewal countersignature",
    status: "completed",
    priority: "medium",
    owner: "sales",
    assignee: "sales",
    dueInDays: -6,
    deal: 14,
    person: 18,
    company: 7,
    description: "Executed copy stored against the account.",
  },
  {
    title: "Log Ironvale churn reason in reporting",
    status: "completed",
    priority: "medium",
    owner: "admin",
    assignee: "admin",
    dueInDays: -18,
    deal: 15,
    person: 13,
    company: 5,
    description: "Capital freeze, not product fit — tagged for the loss report.",
  },
  {
    title: "Review overdue invoice INV-1002",
    status: "open",
    priority: "urgent",
    owner: "admin",
    assignee: "admin",
    dueInDays: -3,
    deal: null,
    person: 7,
    company: 3,
    description: "Five days past due. Confirm whether AP received the invoice.",
  },
  {
    title: "Reconcile Brightline implementation payment",
    status: "completed",
    priority: "medium",
    owner: "sales",
    assignee: "sales",
    dueInDays: -15,
    deal: 9,
    person: 10,
    company: 4,
    description: "Bank transfer matched against INV-1001.",
  },
  {
    title: "Publish the data import knowledge base article",
    status: "in_progress",
    priority: "medium",
    owner: "admin",
    assignee: "admin",
    dueInDays: 4,
    deal: null,
    person: null,
    company: null,
    description: "Draft is written; needs screenshots before publishing.",
  },
  {
    title: "Respond to Verdant WhatsApp template escalation",
    status: "open",
    priority: "urgent",
    owner: "sales",
    assignee: "sales",
    dueInDays: 0,
    deal: null,
    person: 19,
    company: 8,
    description: "Templates stuck in pending for three days; provider ticket raised.",
  },
  {
    title: "Archive the discontinued telephony bundle SKU",
    status: "archived",
    priority: "low",
    owner: "admin",
    assignee: "admin",
    dueInDays: -33,
    deal: null,
    person: null,
    company: null,
    description: "Superseded by the new cloud telephony packaging.",
  },
  {
    title: "Prepare monthly pipeline review deck",
    status: "open",
    priority: "medium",
    owner: "admin",
    assignee: "sales",
    dueInDays: 6,
    deal: null,
    person: null,
    company: null,
    description: "Both pipelines, weighted forecast, and the two at-risk renewals.",
  },
]

/* -------------------------------- products -------------------------------- */

type ProductSeed = {
  sku: string
  name: string
  description: string
  usd: number
  eur: number | null
  owner: Owner
  active: boolean
}

const PRODUCTS: readonly ProductSeed[] = [
  {
    sku: "CRM-CORE",
    name: "YourCRM Core Platform — per seat, annual",
    description: "Contacts, companies, deals, activities and reporting for one named user.",
    usd: 1200,
    eur: 1104,
    owner: "admin",
    active: true,
  },
  {
    sku: "CRM-SALES",
    name: "Sales Automation Add-on — per seat, annual",
    description: "Sequences, quotes and forecasting on top of the core platform.",
    usd: 480,
    eur: 442,
    owner: "admin",
    active: true,
  },
  {
    sku: "CRM-SVC",
    name: "Service Desk Add-on — per seat, annual",
    description: "Ticketing, SLAs and the customer-facing knowledge base.",
    usd: 540,
    eur: 497,
    owner: "sales",
    active: true,
  },
  {
    sku: "CRM-MKT",
    name: "Marketing Automation — per 10k contacts, annual",
    description: "Segments, campaigns and consent tracking.",
    usd: 2400,
    eur: 2208,
    owner: "sales",
    active: true,
  },
  {
    sku: "CRM-AI",
    name: "AI Assistant Credits — 100k actions",
    description: "Assistant, summarisation and agent runs metered by action.",
    usd: 3000,
    eur: 2760,
    owner: "admin",
    active: true,
  },
  {
    sku: "CRM-WA",
    name: "WhatsApp Business Channel — per number, annual",
    description: "One verified business number with template management.",
    usd: 720,
    eur: 662,
    owner: "sales",
    active: true,
  },
  {
    sku: "CRM-TEL",
    name: "Cloud Telephony Bundle — per seat, annual",
    description: "Click-to-call, recording and transcription for one user.",
    usd: 360,
    eur: 331,
    owner: "admin",
    active: false,
  },
  {
    sku: "SVC-IMPL",
    name: "Implementation & Data Migration — fixed fee",
    description: "Discovery, configuration and one migrated legacy dataset.",
    usd: 18000,
    eur: null,
    owner: "admin",
    active: true,
  },
  {
    sku: "SVC-TRAIN",
    name: "Administrator Training Workshop — per day",
    description: "One-day onsite or remote workshop for up to twelve admins.",
    usd: 2200,
    eur: null,
    owner: "sales",
    active: true,
  },
  {
    sku: "SUP-PREM",
    name: "Premium Support — 24x7, annual",
    description: "One-hour response target with a named technical account manager.",
    usd: 9600,
    eur: 8832,
    owner: "admin",
    active: true,
  },
]

/* --------------------------------- quotes --------------------------------- */

type LineSeed = { product: number | null; description: string; quantity: number; unitCents: number }

type QuoteSeed = {
  number: string
  status: "draft" | "sent" | "accepted" | "rejected"
  owner: Owner
  deal: number
  person: number
  createdDaysAgo: number
  expiresInDays: number
  taxRateBps: number
  discountType: "none" | "percent" | "fixed"
  discountValue: number
  terms: string
  lines: readonly LineSeed[]
}

const QUOTES: readonly QuoteSeed[] = [
  {
    number: "Q-2001",
    status: "sent",
    owner: "admin",
    deal: 1,
    person: 1,
    createdDaysAgo: 9,
    expiresInDays: 21,
    taxRateBps: 800,
    discountType: "percent",
    discountValue: 500,
    terms: "Net 30. Phase two invoices only after the first wave is accepted.",
    lines: [
      {
        product: 1,
        description: "YourCRM Core Platform — 120 seats",
        quantity: 120,
        unitCents: 120000,
      },
      {
        product: 2,
        description: "Sales Automation Add-on — 120 seats",
        quantity: 120,
        unitCents: 48000,
      },
      {
        product: 8,
        description: "Implementation & data migration (three waves)",
        quantity: 1,
        unitCents: 1800000,
      },
    ],
  },
  {
    number: "Q-2002",
    status: "accepted",
    owner: "admin",
    deal: 3,
    person: 7,
    createdDaysAgo: 34,
    expiresInDays: -4,
    taxRateBps: 0,
    discountType: "percent",
    discountValue: 1200,
    terms: "Two-year commitment, billed annually in advance. BAA attached.",
    lines: [
      {
        product: 1,
        description: "YourCRM Core Platform — 1,400 seats",
        quantity: 1400,
        unitCents: 120000,
      },
      {
        product: 3,
        description: "Service Desk Add-on — 300 seats",
        quantity: 300,
        unitCents: 54000,
      },
      { product: 10, description: "Premium Support — 24x7", quantity: 1, unitCents: 960000 },
    ],
  },
  {
    number: "Q-2003",
    status: "sent",
    owner: "sales",
    deal: 6,
    person: 14,
    createdDaysAgo: 16,
    expiresInDays: 14,
    taxRateBps: 625,
    discountType: "none",
    discountValue: 0,
    terms: "Net 45. EU hosting option priced in line 3.",
    lines: [
      {
        product: 1,
        description: "YourCRM Core Platform — 140 seats",
        quantity: 140,
        unitCents: 120000,
      },
      {
        product: 5,
        description: "AI Assistant Credits — 100k actions",
        quantity: 2,
        unitCents: 300000,
      },
      {
        product: 8,
        description: "Implementation & data migration",
        quantity: 1,
        unitCents: 1800000,
      },
    ],
  },
  {
    number: "Q-2004",
    status: "draft",
    owner: "admin",
    deal: 5,
    person: 12,
    createdDaysAgo: 3,
    expiresInDays: 30,
    taxRateBps: 800,
    discountType: "none",
    discountValue: 0,
    terms: "Draft pending the Toledo plant seat count.",
    lines: [
      {
        product: 1,
        description: "YourCRM Core Platform — 85 seats",
        quantity: 85,
        unitCents: 120000,
      },
      {
        product: 9,
        description: "Administrator training workshop",
        quantity: 2,
        unitCents: 220000,
      },
    ],
  },
  {
    number: "Q-2005",
    status: "accepted",
    owner: "sales",
    deal: 9,
    person: 10,
    createdDaysAgo: 62,
    expiresInDays: -32,
    taxRateBps: 700,
    discountType: "fixed",
    discountValue: 250000,
    terms: "Signed. Implementation invoiced on kickoff, licences on go-live.",
    lines: [
      {
        product: 1,
        description: "YourCRM Core Platform — 64 seats",
        quantity: 64,
        unitCents: 120000,
      },
      {
        product: 4,
        description: "Marketing Automation — 40k contacts",
        quantity: 4,
        unitCents: 240000,
      },
      {
        product: 8,
        description: "Implementation & data migration",
        quantity: 1,
        unitCents: 1800000,
      },
    ],
  },
]

/* -------------------------------- invoices -------------------------------- */

type PaymentSeed = {
  amountCents: number
  method: "cash" | "card" | "bank_transfer" | "upi" | "other"
  paidDaysAgo: number
  reference: string
}

type InvoiceSeed = {
  number: string
  status: "draft" | "sent" | "paid" | "void"
  owner: Owner
  company: number
  person: number
  quote: number | null
  issuedDaysAgo: number
  dueInDays: number
  notes: string
  lines: readonly LineSeed[]
  payments: readonly PaymentSeed[]
}

const INVOICES: readonly InvoiceSeed[] = [
  {
    number: "INV-1001",
    status: "paid",
    owner: "sales",
    company: 4,
    person: 10,
    quote: 5,
    issuedDaysAgo: 45,
    dueInDays: -15,
    notes: "Loyalty programme implementation, invoiced on kickoff.",
    lines: [
      {
        product: 8,
        description: "Implementation & data migration",
        quantity: 1,
        unitCents: 1800000,
      },
      {
        product: 9,
        description: "Administrator training workshop",
        quantity: 1,
        unitCents: 220000,
      },
    ],
    payments: [
      {
        amountCents: 2020000,
        method: "bank_transfer",
        paidDaysAgo: 18,
        reference: "BRL-TRF-88412",
      },
    ],
  },
  {
    number: "INV-1002",
    status: "sent",
    owner: "admin",
    company: 3,
    person: 7,
    quote: 2,
    issuedDaysAgo: 20,
    dueInDays: -5,
    notes: "OVERDUE — first annual instalment of the patient outreach suite.",
    lines: [
      {
        product: 1,
        description: "YourCRM Core Platform — 1,400 seats (annual)",
        quantity: 1400,
        unitCents: 105600,
      },
      { product: 10, description: "Premium Support — 24x7", quantity: 1, unitCents: 960000 },
    ],
    payments: [
      { amountCents: 5000000, method: "bank_transfer", paidDaysAgo: 6, reference: "CAS-PART-2291" },
    ],
  },
  {
    number: "INV-1003",
    status: "paid",
    owner: "admin",
    company: 1,
    person: 3,
    quote: null,
    issuedDaysAgo: 60,
    dueInDays: -30,
    notes: "Previous contract year, paid in full and on time.",
    lines: [
      {
        product: 1,
        description: "YourCRM Core Platform — 110 seats (annual)",
        quantity: 110,
        unitCents: 120000,
      },
      {
        product: 2,
        description: "Sales Automation Add-on — 110 seats",
        quantity: 110,
        unitCents: 48000,
      },
    ],
    payments: [
      {
        amountCents: 1848000,
        method: "bank_transfer",
        paidDaysAgo: 34,
        reference: "NWL-ACH-70155",
      },
    ],
  },
  {
    number: "INV-1004",
    status: "sent",
    owner: "sales",
    company: 7,
    person: 18,
    quote: null,
    issuedDaysAgo: 8,
    dueInDays: 22,
    notes: "Annual renewal, twelve-month extension.",
    lines: [
      {
        product: 1,
        description: "YourCRM Core Platform — 18 seats (annual)",
        quantity: 18,
        unitCents: 120000,
      },
      {
        product: 6,
        description: "WhatsApp Business Channel — 1 number",
        quantity: 1,
        unitCents: 72000,
      },
    ],
    payments: [],
  },
  {
    number: "INV-1005",
    status: "draft",
    owner: "sales",
    company: 6,
    person: 14,
    quote: 3,
    issuedDaysAgo: 0,
    dueInDays: 30,
    notes: "Draft — held until schedule 2 is countersigned.",
    lines: [
      {
        product: 1,
        description: "YourCRM Core Platform — 140 seats (annual)",
        quantity: 140,
        unitCents: 120000,
      },
      {
        product: 5,
        description: "AI Assistant Credits — 200k actions",
        quantity: 2,
        unitCents: 300000,
      },
    ],
    payments: [],
  },
  {
    number: "INV-1006",
    status: "void",
    owner: "admin",
    company: 2,
    person: 5,
    quote: null,
    issuedDaysAgo: 90,
    dueInDays: -60,
    notes: "Voided when the legacy migration project did not proceed.",
    lines: [
      {
        product: 8,
        description: "Implementation & data migration",
        quantity: 1,
        unitCents: 1800000,
      },
    ],
    payments: [],
  },
]

/* --------------------------------- support -------------------------------- */

type TicketCommentSeed = { author: Owner; internal: boolean; daysAgo: number; body: string }

type TicketSeed = {
  subject: string
  description: string
  status: "new" | "open" | "pending" | "resolved" | "closed"
  priority: "low" | "normal" | "high" | "urgent"
  channel: "email" | "chat" | "whatsapp" | "phone" | "web" | "api" | "manual"
  requester: number
  assignee: Owner | null
  openedDaysAgo: number
  resolvedDaysAgo: number | null
  closedDaysAgo: number | null
  comments: readonly TicketCommentSeed[]
}

const TICKETS: readonly TicketSeed[] = [
  {
    subject: "Telematics sync failing for 12 vehicles",
    description: "Twelve tractors stopped reporting positions after the Tuesday firmware update.",
    status: "open",
    priority: "high",
    channel: "email",
    requester: 1,
    assignee: "admin",
    openedDaysAgo: 3,
    resolvedDaysAgo: null,
    closedDaysAgo: null,
    comments: [
      {
        author: "admin",
        internal: false,
        daysAgo: 3,
        body: "Thanks Dana — we can see the twelve devices dropping out. Investigating now.",
      },
      {
        author: "admin",
        internal: true,
        daysAgo: 2,
        body: "Internal: all twelve are on firmware 4.2.1. Escalated to the device partner.",
      },
      {
        author: "admin",
        internal: false,
        daysAgo: 1,
        body: "The device vendor has a fix in test. We will confirm a rollout window tomorrow.",
      },
    ],
  },
  {
    subject: "SSO login loop after password reset",
    description: "Clinical staff are bounced back to the login screen after resetting a password.",
    status: "pending",
    priority: "urgent",
    channel: "web",
    requester: 8,
    assignee: "admin",
    openedDaysAgo: 2,
    resolvedDaysAgo: null,
    closedDaysAgo: null,
    comments: [
      {
        author: "admin",
        internal: false,
        daysAgo: 2,
        body: "Could you confirm whether the affected users are in the new clinical directory group?",
      },
      {
        author: "admin",
        internal: true,
        daysAgo: 2,
        body: "Internal: looks like a stale assertion cache on their identity provider, not ours.",
      },
    ],
  },
  {
    subject: "Loyalty points not applying at checkout",
    description: "Points are earned but not redeemable in 4 of 64 stores.",
    status: "new",
    priority: "high",
    channel: "whatsapp",
    requester: 10,
    assignee: "sales",
    openedDaysAgo: 1,
    resolvedDaysAgo: null,
    closedDaysAgo: null,
    comments: [
      {
        author: "sales",
        internal: true,
        daysAgo: 1,
        body: "Internal: all four stores are on the older POS build. Needs the service team.",
      },
    ],
  },
  {
    subject: "Export to CSV truncates at 10,000 rows",
    description:
      "Compliance reporting needs the full 43,000-row export, not the first ten thousand.",
    status: "open",
    priority: "normal",
    channel: "email",
    requester: 15,
    assignee: "sales",
    openedDaysAgo: 6,
    resolvedDaysAgo: null,
    closedDaysAgo: null,
    comments: [
      {
        author: "sales",
        internal: false,
        daysAgo: 5,
        body: "Confirmed — the synchronous export caps at 10k. The queued export job has no cap.",
      },
      {
        author: "sales",
        internal: true,
        daysAgo: 5,
        body: "Internal: document the queued export route in the knowledge base.",
      },
    ],
  },
  {
    subject: "API rate limit lower than documented",
    description: "We are throttled at 60 requests a minute; the docs say 120.",
    status: "resolved",
    priority: "normal",
    channel: "api",
    requester: 17,
    assignee: "admin",
    openedDaysAgo: 12,
    resolvedDaysAgo: 9,
    closedDaysAgo: null,
    comments: [
      {
        author: "admin",
        internal: false,
        daysAgo: 11,
        body: "Your key was on the legacy tier. Raised to 120/minute and the docs were right.",
      },
      {
        author: "admin",
        internal: false,
        daysAgo: 9,
        body: "Marking as resolved — shout if you see throttling again.",
      },
    ],
  },
  {
    subject: "Bulk import rejects European date format",
    description: "A CSV with DD/MM/YYYY dates fails validation on every row.",
    status: "resolved",
    priority: "low",
    channel: "chat",
    requester: 4,
    assignee: "sales",
    openedDaysAgo: 21,
    resolvedDaysAgo: 18,
    closedDaysAgo: null,
    comments: [
      {
        author: "sales",
        internal: false,
        daysAgo: 20,
        body: "Set the date format on the import mapping step and it will parse correctly.",
      },
    ],
  },
  {
    subject: "Request: add a custom field to work orders",
    description: "Quality need a 'batch number' field on the work order object.",
    status: "closed",
    priority: "low",
    channel: "manual",
    requester: 13,
    assignee: "admin",
    openedDaysAgo: 34,
    resolvedDaysAgo: 30,
    closedDaysAgo: 26,
    comments: [
      {
        author: "admin",
        internal: false,
        daysAgo: 32,
        body: "Added as a text custom field on the work order custom object.",
      },
      {
        author: "admin",
        internal: true,
        daysAgo: 26,
        body: "Internal: closed after the renewal churned; leaving the field in place.",
      },
    ],
  },
  {
    subject: "WhatsApp templates stuck in pending",
    description: "Three harvest-alert templates have been pending provider approval for 72 hours.",
    status: "open",
    priority: "urgent",
    channel: "phone",
    requester: 19,
    assignee: "sales",
    openedDaysAgo: 3,
    resolvedDaysAgo: null,
    closedDaysAgo: null,
    comments: [
      {
        author: "sales",
        internal: false,
        daysAgo: 3,
        body: "Raised with the provider; approvals are running slowly across the board.",
      },
      {
        author: "sales",
        internal: true,
        daysAgo: 2,
        body: "Internal: provider ticket 55-2291. Chase again if nothing by Friday.",
      },
    ],
  },
]

/* ----------------------------- knowledge base ----------------------------- */

const KB_CATEGORIES: readonly { name: string; slug: string; description: string }[] = [
  {
    name: "Getting Started",
    slug: "getting-started",
    description: "First-week guides for new workspaces and new users.",
  },
  {
    name: "Integrations",
    slug: "integrations",
    description: "Connecting email, WhatsApp, telephony and third-party apps.",
  },
  {
    name: "Billing & Accounts",
    slug: "billing-and-accounts",
    description: "Invoices, payments, seats and plan changes.",
  },
]

type ArticleSeed = {
  category: number
  title: string
  slug: string
  status: "draft" | "published" | "archived"
  author: Owner
  publishedDaysAgo: number | null
  views: number
  body: string
}

const KB_ARTICLES: readonly ArticleSeed[] = [
  {
    category: 1,
    title: "Setting up your first sales pipeline",
    slug: "setting-up-your-first-sales-pipeline",
    status: "published",
    author: "admin",
    publishedDaysAgo: 64,
    views: 412,
    body: "A pipeline is an ordered list of stages a deal moves through. Create one per motion — new business and renewals usually deserve separate pipelines, because the stages genuinely differ. Give every stage a probability so the weighted forecast means something, and mark exactly one won stage and one lost stage per pipeline.",
  },
  {
    category: 1,
    title: "Importing contacts and companies from a CSV",
    slug: "importing-contacts-and-companies-from-a-csv",
    status: "published",
    author: "admin",
    publishedDaysAgo: 52,
    views: 388,
    body: "Export your existing contacts to CSV, then map each column on the import screen. Set the date format explicitly if your file uses DD/MM/YYYY. Imports run as background jobs: you can close the tab, and the job report lists every rejected row with the reason.",
  },
  {
    category: 2,
    title: "Connecting a WhatsApp Business number",
    slug: "connecting-a-whatsapp-business-number",
    status: "published",
    author: "sales",
    publishedDaysAgo: 28,
    views: 233,
    body: "Add the connection under Settings → Integrations, verify the number with the provider, then submit your message templates for approval. Approval usually takes a few hours but can run to several days. Only approved templates may open a conversation outside the 24-hour session window.",
  },
  {
    category: 3,
    title: "Understanding invoice statuses and overdue rules",
    slug: "understanding-invoice-statuses-and-overdue-rules",
    status: "published",
    author: "sales",
    publishedDaysAgo: 14,
    views: 176,
    body: "An invoice is draft until you send it, sent once issued, and paid when recorded payments cover the total. Anything sent whose due date has passed shows as overdue in reporting — the status itself stays sent. Voiding keeps the record and its number without it counting towards revenue.",
  },
  {
    category: 2,
    title: "Exporting more than 10,000 rows",
    slug: "exporting-more-than-ten-thousand-rows",
    status: "draft",
    author: "sales",
    publishedDaysAgo: null,
    views: 0,
    body: "The immediate download caps at 10,000 rows so the request cannot time out. For anything larger, start a queued export job: you will be notified when the file is ready and the download link stays valid for seven days.",
  },
  {
    category: 1,
    title: "Permissions, roles and record ownership",
    slug: "permissions-roles-and-record-ownership",
    status: "draft",
    author: "admin",
    publishedDaysAgo: null,
    views: 0,
    body: "Roles decide which objects a user may act on; ownership decides which records. A member sees workspace-visible records and everything they own; an owner or admin sees everything. Private records are visible only to their owner and to workspace admins — this applies to search results too.",
  },
]

/* -------------------------------- calendar -------------------------------- */

type CalendarSeed = {
  title: string
  owner: Owner
  daysFromNow: number
  hour: number
  durationHours: number
  location: string
  status: "confirmed" | "cancelled"
  person: number | null
  deal: number | null
  description: string
  guests: readonly Owner[]
}

const CALENDAR_EVENTS: readonly CalendarSeed[] = [
  {
    title: "Northwind — operations board readout",
    owner: "admin",
    daysFromNow: -9,
    hour: 14,
    durationHours: 1,
    location: "Zoom",
    status: "confirmed",
    person: 1,
    deal: 1,
    description: "Presented the phased rollout plan to the operations board.",
    guests: ["admin"],
  },
  {
    title: "Brightline loyalty launch retrospective",
    owner: "sales",
    daysFromNow: -10,
    hour: 15,
    durationHours: 1,
    location: "Brightline HQ",
    status: "confirmed",
    person: 10,
    deal: 9,
    description: "What went well, what to fix before the next store wave.",
    guests: ["sales"],
  },
  {
    title: "Cascade Health — BAA legal review",
    owner: "admin",
    daysFromNow: -3,
    hour: 11,
    durationHours: 1,
    location: "Teams",
    status: "confirmed",
    person: 7,
    deal: 3,
    description: "Closed out audit log retention and sub-processor notice.",
    guests: ["admin", "sales"],
  },
  {
    title: "Ironvale — Toledo site survey",
    owner: "admin",
    daysFromNow: 3,
    hour: 9,
    durationHours: 3,
    location: "Toledo plant",
    status: "confirmed",
    person: 12,
    deal: 5,
    description: "Walk the second site before the addendum names a seat count.",
    guests: ["admin"],
  },
  {
    title: "Meridian — final commercial review",
    owner: "sales",
    daysFromNow: 5,
    hour: 13,
    durationHours: 1,
    location: "Zoom",
    status: "confirmed",
    person: 14,
    deal: 6,
    description: "Last step before signature; bring the revised schedule 2.",
    guests: ["sales", "admin"],
  },
  {
    title: "Helios — crew scheduling follow-up",
    owner: "sales",
    daysFromNow: 4,
    hour: 10,
    durationHours: 1,
    location: "Zoom",
    status: "confirmed",
    person: 4,
    deal: 2,
    description: "Answer the SCADA export questions raised after the workshop.",
    guests: ["sales"],
  },
  {
    title: "Verdant pilot kickoff",
    owner: "sales",
    daysFromNow: 8,
    hour: 15,
    durationHours: 1,
    location: "Google Meet",
    status: "confirmed",
    person: 19,
    deal: 8,
    description: "Agree the three success criteria for the 4,000-acre pilot.",
    guests: ["sales"],
  },
  {
    title: "Cascade Health quarterly business review",
    owner: "admin",
    daysFromNow: 9,
    hour: 14,
    durationHours: 2,
    location: "Cascade Health, Seattle",
    status: "confirmed",
    person: 8,
    deal: 12,
    description: "Standing QBR with the programme office ahead of the renewal.",
    guests: ["admin", "sales"],
  },
  {
    title: "Alpine partner portal scoping (cancelled)",
    owner: "admin",
    daysFromNow: 2,
    hour: 16,
    durationHours: 1,
    location: "Zoom",
    status: "cancelled",
    person: 17,
    deal: 7,
    description: "Cancelled — moved into the marketplace review slot instead.",
    guests: ["admin"],
  },
  {
    title: "Monthly pipeline review",
    owner: "admin",
    daysFromNow: 12,
    hour: 9,
    durationHours: 1,
    location: "Zoom",
    status: "confirmed",
    person: null,
    deal: null,
    description: "Both pipelines, weighted forecast and the two at-risk renewals.",
    guests: ["admin", "sales"],
  },
]

/* ------------------------------ notifications ----------------------------- */

type NotificationSeed = {
  user: Owner
  type: string
  title: string
  body: string
  daysAgo: number
  readDaysAgo: number | null
}

const NOTIFICATIONS: readonly NotificationSeed[] = [
  {
    user: "sales",
    type: "task_assigned",
    title: "Task assigned: Prepare Meridian schedule 2 rewrite",
    body: "Demo Admin assigned you a task due in 2 days.",
    daysAgo: 2,
    readDaysAgo: null,
  },
  {
    user: "admin",
    type: "task_overdue",
    title: "Overdue: Send revised Northwind proposal to procurement",
    body: "This task was due 4 days ago and is still open.",
    daysAgo: 0,
    readDaysAgo: null,
  },
  {
    user: "admin",
    type: "deal_updated",
    title: "Cascade Health deal moved to Negotiation",
    body: "Patient Outreach Suite ($242,000) is one step from closed.",
    daysAgo: 6,
    readDaysAgo: 5,
  },
  {
    user: "sales",
    type: "ticket_reply",
    title: "New reply on loyalty points checkout ticket",
    body: "Sofia confirmed the four affected stores.",
    daysAgo: 1,
    readDaysAgo: null,
  },
  {
    user: "sales",
    type: "invoice_paid",
    title: "INV-1001 paid in full",
    body: "Brightline Retail paid $20,200.00 by bank transfer.",
    daysAgo: 18,
    readDaysAgo: 17,
  },
  {
    user: "admin",
    type: "invoice_overdue",
    title: "INV-1002 is overdue",
    body: "Cascade Health's first annual instalment was due 5 days ago.",
    daysAgo: 5,
    readDaysAgo: null,
  },
  {
    user: "sales",
    type: "calendar_reminder",
    title: "Reminder: Meridian final commercial review",
    body: "Starts in 5 days on Zoom. Bring the revised schedule 2.",
    daysAgo: 0,
    readDaysAgo: null,
  },
  {
    user: "admin",
    type: "kb_published",
    title: "New article published: invoice statuses",
    body: "Demo Sales published to Billing & Accounts.",
    daysAgo: 14,
    readDaysAgo: 13,
  },
]

/* --------------------------------- reset ---------------------------------- */

type Db = ReturnType<typeof postgres>

async function resetDemoData(sql: Db): Promise<void> {
  // Children before parents (most relations cascade, but stating the order
  // keeps the reset correct if a foreign key is ever tightened).
  await sql`DELETE FROM payments WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM invoice_line_items WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM invoices WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM quote_line_items WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM quotes WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM product_prices WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM products WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM ticket_comments WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM tickets WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM calendar_event_attendees WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM calendar_events WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM kb_articles WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM kb_categories WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM tasks WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM activities WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM leads WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM deals WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM pipeline_stages WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM pipelines WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM person_phones WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM person_emails WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM people WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM companies WHERE id::text LIKE ${DEMO_ID_PATTERN}`
  await sql`DELETE FROM notifications WHERE id::text LIKE ${DEMO_ID_PATTERN}`
}

/* --------------------------------- inserts -------------------------------- */

async function seedCompanies(sql: Db): Promise<void> {
  for (const [i, c] of COMPANIES.entries()) {
    await sql`
      INSERT INTO companies (id, workspace_id, owner_id, created_by, name, domain, industry, size, status, description)
      VALUES (${companyId(i + 1)}::uuid, ${WORKSPACE}::uuid, ${userId(c.owner)}::uuid, ${userId(c.owner)}::uuid, ${c.name}, ${c.domain}, ${c.industry}, ${c.size}, 'active', ${c.description})
      ON CONFLICT (id) DO NOTHING`
  }
}

async function seedPeople(sql: Db): Promise<void> {
  for (const [i, p] of PEOPLE.entries()) {
    const index = i + 1
    await sql`
      INSERT INTO people (id, workspace_id, owner_id, created_by, first_name, last_name, title, company_id, status, preferred_channel)
      VALUES (${personId(index)}::uuid, ${WORKSPACE}::uuid, ${userId(p.owner)}::uuid, ${userId(p.owner)}::uuid, ${p.first}, ${p.last}, ${p.title}, ${companyId(p.company)}::uuid, 'active', ${p.channel})
      ON CONFLICT (id) DO NOTHING`
    await sql`
      INSERT INTO person_emails (id, workspace_id, person_id, email, label, is_primary)
      VALUES (${id("personEmail", index)}::uuid, ${WORKSPACE}::uuid, ${personId(index)}::uuid, ${personEmail(index)}, 'work', true)
      ON CONFLICT (id) DO NOTHING`
    await sql`
      INSERT INTO person_phones (id, workspace_id, person_id, phone, label, is_primary)
      VALUES (${id("personPhone", index)}::uuid, ${WORKSPACE}::uuid, ${personId(index)}::uuid, ${p.phone}, 'mobile', true)
      ON CONFLICT (id) DO NOTHING`
  }
}

async function seedPipelines(sql: Db): Promise<void> {
  for (const [i, p] of PIPELINES.entries()) {
    await sql`
      INSERT INTO pipelines (id, workspace_id, owner_id, created_by, name, description, status, is_default)
      VALUES (${id("pipeline", i + 1)}::uuid, ${WORKSPACE}::uuid, ${userId(p.owner)}::uuid, ${userId(p.owner)}::uuid, ${p.name}, ${p.description}, 'active', ${p.isDefault})
      ON CONFLICT (id) DO NOTHING`
  }
  for (const s of STAGES) {
    await sql`
      INSERT INTO pipeline_stages (id, workspace_id, pipeline_id, name, color, position, probability, is_won, is_lost)
      VALUES (${id("stage", s.index)}::uuid, ${WORKSPACE}::uuid, ${id("pipeline", s.pipeline)}::uuid, ${s.name}, ${s.color}, ${s.position}, ${s.probability}, ${s.isWon}, ${s.isLost})
      ON CONFLICT (id) DO NOTHING`
  }
}

async function seedDeals(sql: Db, clock: Clock): Promise<void> {
  for (const [i, d] of DEALS.entries()) {
    const index = i + 1
    await sql`
      INSERT INTO deals (id, workspace_id, owner_id, created_by, created_at, name, amount, currency, pipeline_id, stage_id, stage, probability, expected_close_date, person_id, company_id, close_reason, notes)
      VALUES (${dealId(index)}::uuid, ${WORKSPACE}::uuid, ${userId(d.owner)}::uuid, ${userId(d.owner)}::uuid, ${clock.at(-d.createdDaysAgo)}, ${d.name}, ${d.amount.toFixed(2)}, 'USD', ${id("pipeline", d.pipeline)}::uuid, ${id("stage", d.stageIndex)}::uuid, ${d.stage}, ${stageProbability(d.stageIndex)}, ${clock.day(d.closeInDays)}, ${personId(d.person)}::uuid, ${companyId(dealCompany(index))}::uuid, ${d.closeReason}, ${d.notes})
      ON CONFLICT (id) DO NOTHING`
  }
}

async function seedLeads(sql: Db, clock: Clock): Promise<void> {
  for (const [i, l] of LEADS.entries()) {
    const index = i + 1
    // Lead 10 converted into the Verdant account — link it to the real records.
    const personRef = index === 10 ? personId(20) : null
    const companyRef = index === 10 ? companyId(8) : null
    await sql`
      INSERT INTO leads (id, workspace_id, owner_id, created_by, created_at, first_name, last_name, email, phone, company_name, title, source, status, score, notes, person_id, company_id)
      VALUES (${leadId(index)}::uuid, ${WORKSPACE}::uuid, ${userId(l.owner)}::uuid, ${userId(l.owner)}::uuid, ${clock.at(-l.daysAgo)}, ${l.first}, ${l.last}, ${l.email}, ${l.phone}, ${l.company}, ${l.title}, ${l.source}, ${l.status}, ${l.score}, ${l.notes}, ${personRef}::uuid, ${companyRef}::uuid)
      ON CONFLICT (id) DO NOTHING`
  }
}

async function seedActivities(sql: Db, clock: Clock): Promise<void> {
  for (const [i, a] of ACTIVITIES.entries()) {
    const when = clock.at(a.days)
    const completedAt = a.status === "completed" ? when : null
    await sql`
      INSERT INTO activities (id, workspace_id, owner_id, created_by, created_at, title, type, subject_type, subject_id, body, status, due_at, completed_at)
      VALUES (${id("activity", i + 1)}::uuid, ${WORKSPACE}::uuid, ${userId(a.owner)}::uuid, ${userId(a.owner)}::uuid, ${when}, ${a.title}, ${a.type}, ${a.subjectType}, ${activitySubjectId(a)}::uuid, ${a.body}, ${a.status}, ${when}, ${completedAt})
      ON CONFLICT (id) DO NOTHING`
  }
}

async function seedTasks(sql: Db, clock: Clock): Promise<void> {
  for (const [i, t] of TASKS.entries()) {
    const due = clock.at(t.dueInDays)
    const completedAt = t.status === "completed" ? due : null
    await sql`
      INSERT INTO tasks (id, workspace_id, owner_id, created_by, title, description, status, priority, due_date, completed_at, assignee_id, person_id, company_id, deal_id)
      VALUES (${id("task", i + 1)}::uuid, ${WORKSPACE}::uuid, ${userId(t.owner)}::uuid, ${userId(t.owner)}::uuid, ${t.title}, ${t.description}, ${t.status}, ${t.priority}, ${due}, ${completedAt}, ${userId(t.assignee)}::uuid, ${t.person === null ? null : personId(t.person)}::uuid, ${t.company === null ? null : companyId(t.company)}::uuid, ${t.deal === null ? null : dealId(t.deal)}::uuid)
      ON CONFLICT (id) DO NOTHING`
  }
}

async function seedProducts(sql: Db): Promise<void> {
  for (const [i, p] of PRODUCTS.entries()) {
    const index = i + 1
    await sql`
      INSERT INTO products (id, workspace_id, owner_id, created_by, sku, name, description, is_active)
      VALUES (${id("product", index)}::uuid, ${WORKSPACE}::uuid, ${userId(p.owner)}::uuid, ${userId(p.owner)}::uuid, ${p.sku}, ${p.name}, ${p.description}, ${p.active})
      ON CONFLICT (id) DO NOTHING`
    // Price ids are namespaced per product (product index * 10 + currency slot).
    await sql`
      INSERT INTO product_prices (id, workspace_id, product_id, currency, unit_amount)
      VALUES (${id("price", index * 10 + 1)}::uuid, ${WORKSPACE}::uuid, ${id("product", index)}::uuid, 'USD', ${p.usd.toFixed(2)})
      ON CONFLICT (id) DO NOTHING`
    if (p.eur !== null) {
      await sql`
        INSERT INTO product_prices (id, workspace_id, product_id, currency, unit_amount)
        VALUES (${id("price", index * 10 + 2)}::uuid, ${WORKSPACE}::uuid, ${id("product", index)}::uuid, 'EUR', ${p.eur.toFixed(2)})
        ON CONFLICT (id) DO NOTHING`
    }
  }
}

async function seedQuotes(sql: Db, clock: Clock): Promise<void> {
  for (const [i, q] of QUOTES.entries()) {
    const index = i + 1
    const quoteIdValue = id("quote", index)
    await sql`
      INSERT INTO quotes (id, workspace_id, owner_id, created_by, created_at, number, status, currency, expires_at, company_id, person_id, deal_id, discount_type, discount_value, tax_rate_bps, terms)
      VALUES (${quoteIdValue}::uuid, ${WORKSPACE}::uuid, ${userId(q.owner)}::uuid, ${userId(q.owner)}::uuid, ${clock.at(-q.createdDaysAgo)}, ${q.number}, ${q.status}, 'USD', ${clock.day(-q.createdDaysAgo + q.expiresInDays)}, ${companyId(dealCompany(q.deal))}::uuid, ${personId(q.person)}::uuid, ${dealId(q.deal)}::uuid, ${q.discountType}, ${q.discountValue}, ${q.taxRateBps}, ${q.terms})
      ON CONFLICT (id) DO NOTHING`
    for (const [li, line] of q.lines.entries()) {
      await sql`
        INSERT INTO quote_line_items (id, workspace_id, quote_id, product_id, description, quantity, unit_amount_cents, position)
        VALUES (${id("quoteItem", index * 10 + li + 1)}::uuid, ${WORKSPACE}::uuid, ${quoteIdValue}::uuid, ${line.product === null ? null : id("product", line.product)}::uuid, ${line.description}, ${line.quantity}, ${line.unitCents}, ${li})
        ON CONFLICT (id) DO NOTHING`
    }
  }
}

async function seedInvoices(sql: Db, clock: Clock): Promise<void> {
  for (const [i, inv] of INVOICES.entries()) {
    const index = i + 1
    const invoiceIdValue = id("invoice", index)
    await sql`
      INSERT INTO invoices (id, workspace_id, owner_id, created_by, created_at, number, status, currency, issue_date, due_date, company_id, person_id, quote_id, notes)
      VALUES (${invoiceIdValue}::uuid, ${WORKSPACE}::uuid, ${userId(inv.owner)}::uuid, ${userId(inv.owner)}::uuid, ${clock.at(-inv.issuedDaysAgo)}, ${inv.number}, ${inv.status}, 'USD', ${clock.day(-inv.issuedDaysAgo)}, ${clock.day(inv.dueInDays)}, ${companyId(inv.company)}::uuid, ${personId(inv.person)}::uuid, ${inv.quote === null ? null : id("quote", inv.quote)}::uuid, ${inv.notes})
      ON CONFLICT (id) DO NOTHING`
    for (const [li, line] of inv.lines.entries()) {
      await sql`
        INSERT INTO invoice_line_items (id, workspace_id, invoice_id, description, quantity, unit_amount_cents, position)
        VALUES (${id("invoiceItem", index * 10 + li + 1)}::uuid, ${WORKSPACE}::uuid, ${invoiceIdValue}::uuid, ${line.description}, ${line.quantity}, ${line.unitCents}, ${li})
        ON CONFLICT (id) DO NOTHING`
    }
    for (const [pi, pay] of inv.payments.entries()) {
      await sql`
        INSERT INTO payments (id, workspace_id, invoice_id, amount_cents, currency, method, paid_at, reference)
        VALUES (${id("payment", index * 10 + pi + 1)}::uuid, ${WORKSPACE}::uuid, ${invoiceIdValue}::uuid, ${pay.amountCents}, 'USD', ${pay.method}, ${clock.day(-pay.paidDaysAgo)}, ${pay.reference})
        ON CONFLICT (id) DO NOTHING`
    }
  }
}

async function seedTickets(sql: Db, clock: Clock): Promise<void> {
  for (const [i, t] of TICKETS.entries()) {
    const index = i + 1
    const ticketIdValue = id("ticket", index)
    const opened = clock.at(-t.openedDaysAgo)
    const firstResponseAt = t.comments.length > 0 ? clock.at(-t.comments[0]!.daysAgo) : null
    const slaDays = t.priority === "urgent" ? 2 : t.priority === "high" ? 3 : 5
    const resolutionDueAt = new Date(opened.getTime() + slaDays * DAY_MS)
    await sql`
      INSERT INTO tickets (id, workspace_id, created_at, subject, description, status, priority, requester_id, assignee_id, channel, first_response_due_at, first_response_at, resolution_due_at, resolved_at, closed_at)
      VALUES (${ticketIdValue}::uuid, ${WORKSPACE}::uuid, ${opened}, ${t.subject}, ${t.description}, ${t.status}, ${t.priority}, ${personId(t.requester)}::uuid, ${t.assignee === null ? null : userId(t.assignee)}::uuid, ${t.channel}, ${new Date(opened.getTime() + DAY_MS)}, ${firstResponseAt}, ${resolutionDueAt}, ${t.resolvedDaysAgo === null ? null : clock.at(-t.resolvedDaysAgo)}, ${t.closedDaysAgo === null ? null : clock.at(-t.closedDaysAgo)})
      ON CONFLICT (id) DO NOTHING`
    for (const [ci, c] of t.comments.entries()) {
      await sql`
        INSERT INTO ticket_comments (id, workspace_id, created_at, ticket_id, author_id, body, is_internal)
        VALUES (${id("ticketComment", index * 10 + ci + 1)}::uuid, ${WORKSPACE}::uuid, ${clock.at(-c.daysAgo)}, ${ticketIdValue}::uuid, ${userId(c.author)}::uuid, ${c.body}, ${c.internal})
        ON CONFLICT (id) DO NOTHING`
    }
  }
}

async function seedKnowledgeBase(sql: Db, clock: Clock): Promise<void> {
  for (const [i, c] of KB_CATEGORIES.entries()) {
    await sql`
      INSERT INTO kb_categories (id, workspace_id, name, slug, description)
      VALUES (${id("kbCategory", i + 1)}::uuid, ${WORKSPACE}::uuid, ${c.name}, ${c.slug}, ${c.description})
      ON CONFLICT (id) DO NOTHING`
  }
  for (const [i, a] of KB_ARTICLES.entries()) {
    const publishedAt = a.publishedDaysAgo === null ? null : clock.at(-a.publishedDaysAgo)
    await sql`
      INSERT INTO kb_articles (id, workspace_id, created_at, category_id, title, slug, body, status, author_id, published_at, view_count)
      VALUES (${id("kbArticle", i + 1)}::uuid, ${WORKSPACE}::uuid, ${publishedAt ?? clock.at(0)}, ${id("kbCategory", a.category)}::uuid, ${a.title}, ${a.slug}, ${a.body}, ${a.status}, ${userId(a.author)}::uuid, ${publishedAt}, ${a.views})
      ON CONFLICT (id) DO NOTHING`
  }
}

async function seedCalendar(sql: Db, clock: Clock): Promise<void> {
  let attendeeCounter = 0
  for (const [i, e] of CALENDAR_EVENTS.entries()) {
    const index = i + 1
    const eventIdValue = id("calendarEvent", index)
    const start = clock.at(e.daysFromNow, e.hour)
    const end = new Date(start.getTime() + e.durationHours * HOUR_MS)
    await sql`
      INSERT INTO calendar_events (id, workspace_id, owner_id, created_by, title, description, location, start_at, end_at, all_day, status, person_id, company_id, deal_id)
      VALUES (${eventIdValue}::uuid, ${WORKSPACE}::uuid, ${userId(e.owner)}::uuid, ${userId(e.owner)}::uuid, ${e.title}, ${e.description}, ${e.location}, ${start}, ${end}, false, ${e.status}, ${e.person === null ? null : personId(e.person)}::uuid, ${e.person === null ? null : companyId(dealCompany(e.deal ?? 1))}::uuid, ${e.deal === null ? null : dealId(e.deal)}::uuid)
      ON CONFLICT (id) DO NOTHING`
    for (const guest of e.guests) {
      attendeeCounter += 1
      await sql`
        INSERT INTO calendar_event_attendees (id, workspace_id, event_id, user_id, response_status, is_organizer)
        VALUES (${id("calendarAttendee", attendeeCounter)}::uuid, ${WORKSPACE}::uuid, ${eventIdValue}::uuid, ${userId(guest)}::uuid, 'accepted', ${guest === e.owner})
        ON CONFLICT (id) DO NOTHING`
    }
    // External invitee: the linked contact, exercising the user_id XOR email check.
    if (e.person !== null) {
      attendeeCounter += 1
      await sql`
        INSERT INTO calendar_event_attendees (id, workspace_id, event_id, email, name, response_status, is_organizer)
        VALUES (${id("calendarAttendee", attendeeCounter)}::uuid, ${WORKSPACE}::uuid, ${eventIdValue}::uuid, ${personEmail(e.person)}, ${personName(e.person)}, 'needs_action', false)
        ON CONFLICT (id) DO NOTHING`
    }
  }
}

async function seedNotifications(sql: Db, clock: Clock): Promise<void> {
  for (const [i, n] of NOTIFICATIONS.entries()) {
    const readAt = n.readDaysAgo === null ? null : clock.at(-n.readDaysAgo)
    await sql`
      INSERT INTO notifications (id, workspace_id, created_at, user_id, type, title, body, read_at)
      VALUES (${id("notification", i + 1)}::uuid, ${WORKSPACE}::uuid, ${clock.at(-n.daysAgo)}, ${userId(n.user)}::uuid, ${n.type}, ${n.title}, ${n.body}, ${readAt})
      ON CONFLICT (id) DO NOTHING`
  }
}

/* --------------------------------- report --------------------------------- */

async function printCounts(sql: Db): Promise<void> {
  const tables = [
    "companies",
    "people",
    "person_emails",
    "person_phones",
    "pipelines",
    "pipeline_stages",
    "deals",
    "leads",
    "tasks",
    "activities",
    "tickets",
    "ticket_comments",
    "products",
    "product_prices",
    "quotes",
    "quote_line_items",
    "invoices",
    "invoice_line_items",
    "payments",
    "kb_categories",
    "kb_articles",
    "calendar_events",
    "calendar_event_attendees",
    "notifications",
  ] as const
  for (const table of tables) {
    const rows =
      await sql`SELECT COUNT(*)::int AS n FROM ${sql(table)} WHERE id::text LIKE ${DEMO_ID_PATTERN}`
    const count = (rows[0] as { n: number }).n
    console.log(`  ${table}: ${count}`)
  }
  const split = (await sql`
    SELECT
      CASE WHEN owner_id = ${ADMIN}::uuid THEN 'admin' ELSE 'sales' END AS owner,
      COUNT(*)::int AS n
    FROM (
      SELECT owner_id FROM companies WHERE id::text LIKE ${DEMO_ID_PATTERN}
      UNION ALL SELECT owner_id FROM people WHERE id::text LIKE ${DEMO_ID_PATTERN}
      UNION ALL SELECT owner_id FROM pipelines WHERE id::text LIKE ${DEMO_ID_PATTERN}
      UNION ALL SELECT owner_id FROM deals WHERE id::text LIKE ${DEMO_ID_PATTERN}
      UNION ALL SELECT owner_id FROM leads WHERE id::text LIKE ${DEMO_ID_PATTERN}
      UNION ALL SELECT owner_id FROM tasks WHERE id::text LIKE ${DEMO_ID_PATTERN}
      UNION ALL SELECT owner_id FROM activities WHERE id::text LIKE ${DEMO_ID_PATTERN}
      UNION ALL SELECT owner_id FROM products WHERE id::text LIKE ${DEMO_ID_PATTERN}
      UNION ALL SELECT owner_id FROM quotes WHERE id::text LIKE ${DEMO_ID_PATTERN}
      UNION ALL SELECT owner_id FROM invoices WHERE id::text LIKE ${DEMO_ID_PATTERN}
    ) owned
    GROUP BY 1
    ORDER BY 1`) as { owner: string; n: number }[]
  for (const row of split) console.log(`  owned by ${row.owner}: ${row.n}`)
}

/* ---------------------------------- main ---------------------------------- */

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required to seed")
  const sql = postgres(url, { max: 1 })
  try {
    if (process.env.SEED_RESET === "1") {
      console.log("Removing demo seed data...")
      await resetDemoData(sql)
    }

    const ws = await sql`SELECT id FROM workspaces WHERE id = ${WORKSPACE}::uuid`
    if (ws.length === 0) throw new Error("Demo workspace missing — run `bun run db:seed` first")
    const users =
      await sql`SELECT COUNT(*)::int AS n FROM users WHERE id IN (${ADMIN}::uuid, ${SALES}::uuid)`
    if ((users[0] as { n: number }).n !== 2) {
      throw new Error("Demo users missing — run `bun run db:seed` first")
    }

    const nowRows = (await sql`SELECT NOW() AS now`) as { now: Date }[]
    const clock = makeClock(nowRows[0]!.now)

    await seedCompanies(sql)
    await seedPeople(sql)
    await seedPipelines(sql)
    await seedDeals(sql, clock)
    await seedLeads(sql, clock)
    await seedActivities(sql, clock)
    await seedTasks(sql, clock)
    await seedTickets(sql, clock)
    await seedProducts(sql)
    await seedQuotes(sql, clock)
    await seedInvoices(sql, clock)
    await seedKnowledgeBase(sql, clock)
    await seedCalendar(sql, clock)
    await seedNotifications(sql, clock)

    console.log("Demo seed complete. Row counts (demo ids only):")
    await printCounts(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

await main().catch((err) => {
  console.error("Demo seed failed:", err)
  process.exit(1)
})
