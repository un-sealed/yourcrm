/**
 * SSRF guard for outbound webhook targets.
 *
 * A subscription URL is supplied by a workspace admin and then fetched BY
 * THE SERVER, from inside the deployment's network. That makes it the
 * classic server-side request forgery primitive: `http://169.254.169.254/`
 * is the cloud instance-metadata endpoint, `http://10.0.0.1` is whatever
 * else runs on the private network, and `http://localhost:5432` is this
 * deployment's own Postgres.
 *
 * The guard therefore runs TWICE:
 *
 *  1. `assertWebhookUrl()` at save time — cheap, synchronous, and it keeps
 *     an obviously hostile row out of the database at all.
 *  2. `assertDeliverableWebhookUrl()` immediately before EVERY delivery
 *     attempt, with DNS resolution — because a hostname that resolved to a
 *     public address when it was saved can resolve to 127.0.0.1 an hour
 *     later (DNS rebinding). A save-time-only check is not a check.
 *
 * Policy is a DENYLIST of address ranges over an ALLOWLIST of one scheme:
 *
 *  - scheme: `https:` only. Plain HTTP would ship signed payloads in clear
 *    text, and every interesting SSRF target speaks it.
 *  - no embedded credentials (`https://real.example@evil.example` is a
 *    parser-confusion classic, and any `user:pass` would be leaked to the
 *    target anyway).
 *  - hostnames: `localhost`, `*.localhost`, and the `.local`,
 *    `.internal`, `.localdomain`, `.home.arpa` and `.onion` suffixes.
 *    `metadata.google.internal` falls out of `.internal`.
 *  - a host that LOOKS numeric must parse as a strict dotted-quad IPv4.
 *    `0177.0.0.1`, `0x7f.1` and `2130706433` are all 127.0.0.1 to a
 *    resolver, so an "is it an IP?" test that only understands dotted
 *    quads would wave them through as hostnames.
 *  - IPv4 literals: 0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16
 *    (link-local + metadata), 172.16/12, 192.0.0/24, 192.0.2/24,
 *    192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24,
 *    224/4 (multicast) and 240/4 (reserved, incl. 255.255.255.255).
 *  - IPv6 literals: `::`, `::1`, fc00::/7 (ULA), fe80::/10 (link-local),
 *    ff00::/8 (multicast), 2001:db8::/32, 100::/64, and the IPv4-embedding
 *    prefixes `::ffff:0:0/96` and `64:ff9b::/96` — an IPv4-mapped address
 *    is checked against the IPv4 rules above, so `::ffff:169.254.169.254`
 *    is blocked for the same reason its dotted form is.
 *
 * REMAINING GAP, stated rather than hidden: between the DNS re-check and
 * the socket connect there is still a TOCTOU window unless the transport
 * connects to a pinned address. `WebhookTransportRequest` therefore carries
 * `resolvedAddresses`, so a hardened transport can pin one; the guard
 * cannot do that itself without owning the socket.
 */

const MAX_URL_LENGTH = 2048

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".localdomain",
  ".home.arpa",
  ".onion",
] as const

const BLOCKED_HOSTS = ["localhost", "ip6-localhost", "ip6-loopback"] as const

export class WebhookUrlNotAllowedError extends Error {
  readonly code = "WEBHOOK_URL_NOT_ALLOWED"
  constructor(
    readonly reason: string,
    readonly target: string,
  ) {
    super(`webhook target is not allowed: ${reason}`)
    this.name = "WebhookUrlNotAllowedError"
  }
}

export type WebhookUrlCheck = { allowed: true; url: URL } | { allowed: false; reason: string }

/* ------------------------------ IP parsing ----------------------------- */

/** Strict dotted-quad. Rejects leading zeros, so no octal reinterpretation. */
function parseIpv4(value: string): number[] | null {
  const parts = value.split(".")
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    octets.push(n)
  }
  return octets
}

/** Parse an IPv6 literal (with optional `::` and trailing IPv4) to 8 words. */
function parseIpv6(value: string): number[] | null {
  const text = value.toLowerCase()
  if (text.length === 0 || /[^0-9a-f:.]/.test(text)) return null

  let head = text
  let tail4: number[] | null = null
  const lastColon = text.lastIndexOf(":")
  if (text.includes(".")) {
    const maybe4 = text.slice(lastColon + 1)
    tail4 = parseIpv4(maybe4)
    if (!tail4) return null
    head = text.slice(0, lastColon + 1)
    // Drop the trailing colon so the split below behaves like a pure IPv6.
    head = head.slice(0, -1)
    if (head.endsWith(":") && !head.endsWith("::")) return null
  }

  const doubleColonCount = head.split("::").length - 1
  if (doubleColonCount > 1) return null

  const expand = (segment: string): number[] | null => {
    if (segment === "") return []
    const words: number[] = []
    for (const group of segment.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      words.push(Number.parseInt(group, 16))
    }
    return words
  }

  const tailWords = tail4
    ? [((tail4[0] ?? 0) << 8) | (tail4[1] ?? 0), ((tail4[2] ?? 0) << 8) | (tail4[3] ?? 0)]
    : []

  let words: number[]
  if (doubleColonCount === 1) {
    const [left = "", right = ""] = head.split("::")
    const leftWords = expand(left)
    const rightWords = expand(right)
    if (!leftWords || !rightWords) return null
    const used = leftWords.length + rightWords.length + tailWords.length
    if (used > 8) return null
    words = [...leftWords, ...Array<number>(8 - used).fill(0), ...rightWords, ...tailWords]
  } else {
    const explicit = expand(head)
    if (!explicit) return null
    words = [...explicit, ...tailWords]
  }
  return words.length === 8 ? words : null
}

function inCidr4(octets: number[], prefix: number[], bits: number): boolean {
  const value =
    ((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)
  const base =
    ((prefix[0] ?? 0) << 24) | ((prefix[1] ?? 0) << 16) | ((prefix[2] ?? 0) << 8) | (prefix[3] ?? 0)
  const mask = bits === 0 ? 0 : ~0 << (32 - bits)
  return (value & mask) === (base & mask)
}

const BLOCKED_IPV4: { cidr: string; prefix: number[]; bits: number }[] = [
  { cidr: "0.0.0.0/8", prefix: [0, 0, 0, 0], bits: 8 },
  { cidr: "10.0.0.0/8", prefix: [10, 0, 0, 0], bits: 8 },
  { cidr: "100.64.0.0/10", prefix: [100, 64, 0, 0], bits: 10 },
  { cidr: "127.0.0.0/8", prefix: [127, 0, 0, 0], bits: 8 },
  { cidr: "169.254.0.0/16", prefix: [169, 254, 0, 0], bits: 16 },
  { cidr: "172.16.0.0/12", prefix: [172, 16, 0, 0], bits: 12 },
  { cidr: "192.0.0.0/24", prefix: [192, 0, 0, 0], bits: 24 },
  { cidr: "192.0.2.0/24", prefix: [192, 0, 2, 0], bits: 24 },
  { cidr: "192.88.99.0/24", prefix: [192, 88, 99, 0], bits: 24 },
  { cidr: "192.168.0.0/16", prefix: [192, 168, 0, 0], bits: 16 },
  { cidr: "198.18.0.0/15", prefix: [198, 18, 0, 0], bits: 15 },
  { cidr: "198.51.100.0/24", prefix: [198, 51, 100, 0], bits: 24 },
  { cidr: "203.0.113.0/24", prefix: [203, 0, 113, 0], bits: 24 },
  { cidr: "224.0.0.0/4", prefix: [224, 0, 0, 0], bits: 4 },
  { cidr: "240.0.0.0/4", prefix: [240, 0, 0, 0], bits: 4 },
]

function blockedIpv4Reason(octets: number[]): string | null {
  const hit = BLOCKED_IPV4.find((range) => inCidr4(octets, range.prefix, range.bits))
  return hit ? `address ${octets.join(".")} is in the blocked range ${hit.cidr}` : null
}

function blockedIpv6Reason(words: number[], original: string): string | null {
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words
  const isZeroPrefix = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96): the real target
  // is the embedded IPv4, so it gets the IPv4 policy.
  const embedded =
    (isZeroPrefix && w5 === 0xffff) ||
    (w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0)
  if (embedded) {
    const octets = [w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff]
    return blockedIpv4Reason(octets) ?? null
  }

  if (words.every((word) => word === 0)) return `address ${original} is the unspecified address ::`
  if (isZeroPrefix && w5 === 0 && w6 === 0 && w7 === 1) {
    return `address ${original} is the IPv6 loopback ::1`
  }
  if ((w0 & 0xfe00) === 0xfc00) return `address ${original} is in the blocked range fc00::/7`
  if ((w0 & 0xffc0) === 0xfe80) return `address ${original} is in the blocked range fe80::/10`
  if ((w0 & 0xff00) === 0xff00) return `address ${original} is in the blocked range ff00::/8`
  if (w0 === 0x2001 && w1 === 0x0db8) {
    return `address ${original} is in the blocked range 2001:db8::/32`
  }
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) {
    return `address ${original} is in the blocked range 100::/64`
  }
  return null
}

/**
 * Is this literal address one the server must never connect to?
 *
 * Accepts IPv4 dotted-quads and IPv6 literals (bracketed or not). An
 * unparseable value is treated as BLOCKED: the guard must fail closed.
 */
export function isBlockedIpAddress(address: string): boolean {
  return blockedAddressReason(address) !== null
}

/** The reason an address is blocked, or `null` when it is allowed. */
export function blockedAddressReason(address: string): string | null {
  const value = address.trim().replace(/^\[|\]$/g, "")
  if (value === "") return "empty address"
  const v4 = parseIpv4(value)
  if (v4) return blockedIpv4Reason(v4)
  const v6 = parseIpv6(value)
  if (v6) return blockedIpv6Reason(v6, value)
  return `"${address}" is not a parseable IP address`
}

/* ------------------------------ URL policy ----------------------------- */

/** A host made only of digits, dots and hex escapes must parse as an IPv4. */
function looksNumeric(host: string): boolean {
  return /^[0-9]/.test(host) && /^[0-9a-fx.]+$/i.test(host)
}

/**
 * Save-time check. Synchronous and DNS-free: it decides on the URL's own
 * text, so it can run inside zod validation and inside the service.
 */
export function checkWebhookUrl(raw: string): WebhookUrlCheck {
  const text = raw.trim()
  if (text.length === 0) return { allowed: false, reason: "URL is empty" }
  if (text.length > MAX_URL_LENGTH) {
    return { allowed: false, reason: `URL is longer than ${MAX_URL_LENGTH} characters` }
  }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { allowed: false, reason: "URL is not parseable" }
  }

  if (url.protocol !== "https:") {
    return {
      allowed: false,
      reason: `scheme "${url.protocol.replace(":", "")}" is not allowed — webhook targets must be https`,
    }
  }
  if (url.username !== "" || url.password !== "") {
    return { allowed: false, reason: "URL must not embed credentials" }
  }

  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase()
  if (host === "") return { allowed: false, reason: "URL has no host" }

  if ((BLOCKED_HOSTS as readonly string[]).includes(host)) {
    return { allowed: false, reason: `host "${host}" is a loopback name` }
  }
  const suffix = BLOCKED_HOST_SUFFIXES.find((s) => host.endsWith(s))
  if (suffix) {
    return { allowed: false, reason: `host "${host}" uses the internal suffix "${suffix}"` }
  }

  // IPv6 literals always arrive bracketed, so a bracketed host is an IP.
  if (url.hostname.startsWith("[")) {
    const reason = blockedAddressReason(host)
    return reason ? { allowed: false, reason } : { allowed: true, url }
  }

  const v4 = parseIpv4(host)
  if (v4) {
    const reason = blockedIpv4Reason(v4)
    return reason ? { allowed: false, reason } : { allowed: true, url }
  }
  if (looksNumeric(host)) {
    // `0177.0.0.1`, `0x7f.1`, `2130706433` — a resolver reads these as
    // 127.0.0.1; a dotted-quad parser reads them as a hostname. Refuse.
    return {
      allowed: false,
      reason: `host "${host}" looks like a numeric address but is not a plain dotted-quad IPv4`,
    }
  }

  return { allowed: true, url }
}

/** `checkWebhookUrl`, throwing. Used by the service before any write. */
export function assertWebhookUrl(raw: string): URL {
  const result = checkWebhookUrl(raw)
  if (!result.allowed) throw new WebhookUrlNotAllowedError(result.reason, raw)
  return result.url
}

/* ---------------------------- delivery time ---------------------------- */

/**
 * Hostname -> addresses. Injected so tests are hermetic (no real DNS) and
 * so a deployment can supply its own resolver.
 */
export type WebhookDnsResolverPort = (hostname: string) => Promise<readonly string[]>

/**
 * Node resolver. Imported lazily inside the call so merely importing this
 * module performs no I/O and pulls in no node builtin at module scope —
 * route factories must stay side-effect free.
 */
export function createNodeDnsResolver(): WebhookDnsResolverPort {
  return async (hostname: string) => {
    const dns = await import("node:dns/promises")
    const records = await dns.lookup(hostname, { all: true, verbatim: true })
    return records.map((record) => record.address)
  }
}

export type DeliverableWebhookTarget = {
  url: URL
  /**
   * Every address the hostname resolved to, all of them vetted. A transport
   * that can pin a connection should pin one of these — see the TOCTOU note
   * in the file header.
   */
  resolvedAddresses: string[]
}

/**
 * Delivery-time check: re-run the save-time policy, then resolve the
 * hostname and apply the address policy to EVERY answer. One bad address in
 * a round-robin set fails the whole delivery — a partial block is no block.
 */
export async function assertDeliverableWebhookUrl(
  raw: string,
  resolve?: WebhookDnsResolverPort,
): Promise<DeliverableWebhookTarget> {
  const url = assertWebhookUrl(raw)
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase()

  // A literal address was already vetted by `assertWebhookUrl`; there is no
  // name to resolve, so there is no rebinding window either.
  if (url.hostname.startsWith("[") || parseIpv4(host)) {
    return { url, resolvedAddresses: [host] }
  }

  if (!resolve) {
    throw new WebhookUrlNotAllowedError(
      `host "${host}" needs DNS re-validation but no resolver was provided`,
      raw,
    )
  }

  let addresses: readonly string[]
  try {
    addresses = await resolve(host)
  } catch (err) {
    throw new WebhookUrlNotAllowedError(
      `host "${host}" could not be resolved (${err instanceof Error ? err.message : String(err)})`,
      raw,
    )
  }
  if (addresses.length === 0) {
    throw new WebhookUrlNotAllowedError(`host "${host}" resolved to no addresses`, raw)
  }
  for (const address of addresses) {
    const reason = blockedAddressReason(address)
    if (reason) {
      throw new WebhookUrlNotAllowedError(
        `host "${host}" resolves to a blocked address: ${reason}`,
        raw,
      )
    }
  }
  return { url, resolvedAddresses: [...addresses] }
}
