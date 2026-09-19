import { describe, expect, test } from "bun:test"
import {
  assertDeliverableWebhookUrl,
  assertWebhookUrl,
  blockedAddressReason,
  checkWebhookUrl,
  isBlockedIpAddress,
  WebhookUrlNotAllowedError,
  type WebhookDnsResolverPort,
} from "./url-guard"

/**
 * SSRF is the one thing this module can get wrong that hurts the host
 * rather than the user, so the cases below are enumerated rather than
 * sampled — and each blocked case is asserted on its https form too, so a
 * test cannot pass merely because the scheme check fired first.
 */

const rejected = (url: string): string => {
  const result = checkWebhookUrl(url)
  expect(result.allowed).toBe(false)
  return result.allowed ? "" : result.reason
}

describe("api-webhooks/url-guard/ssrf", () => {
  test("the three named attacks are rejected", () => {
    // Exactly as written in the module brief.
    expect(rejected("http://localhost")).toContain("https")
    expect(rejected("http://169.254.169.254/")).toContain("https")
    expect(rejected("http://10.0.0.1")).toContain("https")

    // …and for the right reason, not just because they are plain HTTP.
    // Switching the scheme must not make any of them acceptable.
    expect(rejected("https://localhost")).toContain("loopback")
    expect(rejected("https://169.254.169.254/")).toContain("169.254.0.0/16")
    expect(rejected("https://10.0.0.1")).toContain("10.0.0.0/8")
  })

  test("only https is allowed", () => {
    for (const url of [
      "http://hooks.example.com/x",
      "ftp://hooks.example.com/x",
      "file:///etc/passwd",
      "gopher://hooks.example.com/",
      "redis://hooks.example.com:6379",
    ]) {
      expect(rejected(url)).toContain("https")
    }
    expect(checkWebhookUrl("https://hooks.example.com/x").allowed).toBe(true)
  })

  test("loopback and internal hostnames are rejected", () => {
    expect(rejected("https://localhost:8443/hook")).toContain("loopback")
    expect(rejected("https://api.localhost/hook")).toContain(".localhost")
    expect(rejected("https://db.internal/hook")).toContain(".internal")
    expect(rejected("https://metadata.google.internal/computeMetadata/v1/")).toContain(".internal")
    expect(rejected("https://printer.local/hook")).toContain(".local")
    expect(rejected("https://box.localdomain/hook")).toContain(".localdomain")
    expect(rejected("https://thing.home.arpa/hook")).toContain(".home.arpa")
    // A trailing dot is the same name to a resolver, so it is to the guard.
    expect(rejected("https://localhost./hook")).toContain("loopback")
  })

  test("every private and special IPv4 range is rejected", () => {
    const cases: [string, string][] = [
      ["0.0.0.0", "0.0.0.0/8"],
      ["10.0.0.1", "10.0.0.0/8"],
      ["100.64.1.1", "100.64.0.0/10"],
      ["127.0.0.1", "127.0.0.0/8"],
      ["127.1.2.3", "127.0.0.0/8"],
      ["169.254.169.254", "169.254.0.0/16"],
      ["172.16.0.1", "172.16.0.0/12"],
      ["172.31.255.254", "172.16.0.0/12"],
      ["192.168.1.1", "192.168.0.0/16"],
      ["198.18.0.1", "198.18.0.0/15"],
      ["224.0.0.1", "224.0.0.0/4"],
      ["255.255.255.255", "240.0.0.0/4"],
    ]
    for (const [address, cidr] of cases) {
      expect(rejected(`https://${address}/hook`)).toContain(cidr)
      expect(isBlockedIpAddress(address)).toBe(true)
    }
    // A genuinely public address is fine.
    expect(checkWebhookUrl("https://93.184.216.34/hook").allowed).toBe(true)
    expect(isBlockedIpAddress("93.184.216.34")).toBe(false)
    // 172.32.x is OUTSIDE 172.16/12 — the mask must not be a /8.
    expect(checkWebhookUrl("https://172.32.0.1/hook").allowed).toBe(true)
  })

  test("IPv6 loopback, link-local, ULA and IPv4-mapped forms are rejected", () => {
    expect(rejected("https://[::1]/hook")).toContain("loopback")
    expect(rejected("https://[::]/hook")).toContain("unspecified")
    expect(rejected("https://[fe80::1]/hook")).toContain("fe80::/10")
    expect(rejected("https://[fd00::1]/hook")).toContain("fc00::/7")
    expect(rejected("https://[ff02::1]/hook")).toContain("ff00::/8")
    expect(rejected("https://[2001:db8::1]/hook")).toContain("2001:db8::/32")
    // An IPv4-mapped v6 literal is the embedded IPv4 as far as the network
    // stack is concerned, so it gets the IPv4 policy.
    expect(rejected("https://[::ffff:169.254.169.254]/hook")).toContain("169.254.0.0/16")
    expect(rejected("https://[::ffff:10.0.0.1]/hook")).toContain("10.0.0.0/8")
    expect(rejected("https://[64:ff9b::127.0.0.1]/hook")).toContain("127.0.0.0/8")
    // A public v6 address is allowed.
    expect(checkWebhookUrl("https://[2606:2800:220:1:248:1893:25c8:1946]/hook").allowed).toBe(true)
  })

  test("numeric host encodings that a resolver would read as loopback are rejected", () => {
    // All of these reach 127.0.0.1. A naive dotted-quad test sees them as
    // ordinary hostnames and waves them through.
    for (const host of ["0177.0.0.1", "2130706433", "0x7f000001", "127.1"]) {
      const reason = rejected(`https://${host}/hook`)
      expect(reason).toMatch(/numeric|blocked range/)
    }
  })

  test("embedded credentials and malformed URLs are rejected", () => {
    expect(rejected("https://real.example.com@evil.example.com/hook")).toContain("credentials")
    expect(rejected("https://user:pass@hooks.example.com/hook")).toContain("credentials")
    expect(rejected("not a url")).toContain("parseable")
    expect(rejected("")).toContain("empty")
    expect(rejected(`https://hooks.example.com/${"x".repeat(2100)}`)).toContain("longer than")
  })

  test("blockedAddressReason fails closed on anything it cannot parse", () => {
    expect(blockedAddressReason("not-an-ip")).toContain("not a parseable IP")
    expect(blockedAddressReason("")).toContain("empty")
    expect(isBlockedIpAddress("999.1.1.1")).toBe(true)
  })

  test("assertWebhookUrl throws a typed, reasoned error", () => {
    expect(() => assertWebhookUrl("https://10.0.0.1/hook")).toThrow(WebhookUrlNotAllowedError)
    try {
      assertWebhookUrl("https://10.0.0.1/hook")
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookUrlNotAllowedError)
      expect((err as WebhookUrlNotAllowedError).code).toBe("WEBHOOK_URL_NOT_ALLOWED")
      expect((err as WebhookUrlNotAllowedError).target).toBe("https://10.0.0.1/hook")
    }
    expect(assertWebhookUrl("https://hooks.example.com/x").hostname).toBe("hooks.example.com")
  })
})

describe("api-webhooks/url-guard/delivery-time-recheck", () => {
  const resolver =
    (addresses: string[]): WebhookDnsResolverPort =>
    async () =>
      addresses

  test("DNS REBINDING: a name that now resolves to a private address is refused", async () => {
    // Saved while it resolved publicly; re-checked at delivery time, when
    // it resolves to the metadata endpoint. This is the whole reason the
    // guard runs twice.
    const url = "https://hooks.example.com/x"
    expect(checkWebhookUrl(url).allowed).toBe(true)
    await expect(assertDeliverableWebhookUrl(url, resolver(["169.254.169.254"]))).rejects.toThrow(
      WebhookUrlNotAllowedError,
    )
    await expect(assertDeliverableWebhookUrl(url, resolver(["127.0.0.1"]))).rejects.toThrow(
      /127.0.0.0\/8/,
    )
  })

  test("ONE bad address in a round-robin set fails the whole delivery", async () => {
    await expect(
      assertDeliverableWebhookUrl(
        "https://hooks.example.com/x",
        resolver(["93.184.216.34", "10.1.2.3"]),
      ),
    ).rejects.toThrow(/10.0.0.0\/8/)
  })

  test("a public answer is allowed and the addresses come back for pinning", async () => {
    const target = await assertDeliverableWebhookUrl(
      "https://hooks.example.com/x",
      resolver(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]),
    )
    expect(target.url.hostname).toBe("hooks.example.com")
    expect(target.resolvedAddresses).toEqual([
      "93.184.216.34",
      "2606:2800:220:1:248:1893:25c8:1946",
    ])
  })

  test("a literal address needs no resolver; a hostname without one is refused", async () => {
    const literal = await assertDeliverableWebhookUrl("https://93.184.216.34/x")
    expect(literal.resolvedAddresses).toEqual(["93.184.216.34"])
    await expect(assertDeliverableWebhookUrl("https://hooks.example.com/x")).rejects.toThrow(
      /no resolver/,
    )
  })

  test("resolution failures and empty answers are refusals, not pass-throughs", async () => {
    await expect(
      assertDeliverableWebhookUrl("https://hooks.example.com/x", async () => {
        throw new Error("ENOTFOUND")
      }),
    ).rejects.toThrow(/could not be resolved/)
    await expect(
      assertDeliverableWebhookUrl("https://hooks.example.com/x", resolver([])),
    ).rejects.toThrow(/no addresses/)
  })
})
