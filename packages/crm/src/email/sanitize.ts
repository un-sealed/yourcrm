/**
 * Inbound-HTML handling (spec 14-email §17, P0).
 *
 * THE POSTURE: inbound email bodies are attacker-controlled. The web UI
 * therefore renders the TEXT part only — it never calls
 * `dangerouslySetInnerHTML`, so there is no HTML injection surface in the
 * browser at all. These functions exist so the two things that DO touch
 * provider HTML are safe:
 *
 * - `emailHtmlToText()` derives the text we render when the provider sent
 *   `text/html` and no `text/plain` alternative. Script/style bodies are
 *   dropped before tags are stripped, so `<script>alert(1)</script>` becomes
 *   nothing rather than the literal string `alert(1)`.
 * - `sanitizeEmailHtml()` scrubs the copy stored in `email_messages.body_html`.
 *   That column is kept for a future rich renderer and is NOT part of any
 *   API response today; storing it pre-scrubbed means a later renderer
 *   cannot inherit today's raw payload.
 *
 * WHAT IS REMOVED
 * 1. Comments (`<!-- … -->`), including conditional comments.
 * 2. Dangerous elements *with their contents*: script, style, iframe, frame,
 *    frameset, object, embed, applet, link, meta, base, form, svg, math,
 *    noscript, template. Then any orphan open/close tag of the same names.
 * 3. Every `on*` event-handler attribute (`onclick`, `onerror`, …).
 * 4. Script-bearing URL schemes (`javascript:`, `vbscript:`, `data:`,
 *    `file:`) in any attribute value — neutralised to `#`.
 * 5. `style`, `srcdoc`, `formaction`, `xlink:href` and `xmlns:*` attributes:
 *    CSS can reach script (`expression()`, `url(javascript:)`) and the rest
 *    are direct execution vectors.
 *
 * This is an allow-nothing-dangerous scrubber, not a full HTML5 parser. It
 * is the second line of defence; the first is "we render text". If a rich
 * HTML view is ever built, swap this for a real sanitiser library (a
 * dependency this agent may not add — reported as a blocker) and keep both.
 */

/** Elements whose entire subtree is dropped. */
const EMAIL_UNSAFE_ELEMENTS = [
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "form",
  "svg",
  "math",
  "noscript",
  "template",
] as const

/** URL schemes that can execute. Matched after stripping whitespace/entities. */
const EMAIL_UNSAFE_URL_SCHEMES = ["javascript:", "vbscript:", "data:", "file:"] as const

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
const EVENT_HANDLER_ATTR_RE = /\son[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
const UNSAFE_ATTR_RE =
  /\s(?:style|srcdoc|formaction|background|xlink:href|xmlns(?::[a-z0-9_-]+)?)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
const ATTR_VALUE_RE = /(\s[a-z0-9_:-]+\s*=\s*)("([^"]*)"|'([^']*)'|([^\s>]+))/gi
const TAG_RE = /<\/?[a-z!][^>]*>/gi

/** Strip unsafe elements *and* their contents, then any orphan tags. */
function dropUnsafeElements(html: string): string {
  let out = html.replace(HTML_COMMENT_RE, "")
  for (const tag of EMAIL_UNSAFE_ELEMENTS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "")
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "")
  }
  return out
}

/**
 * True when a URL value resolves to an executable scheme. Whitespace, NUL
 * and HTML entities are stripped first because `java&#115;cript:` and
 * `java\tscript:` both execute in a browser.
 */
export function isUnsafeEmailUrl(value: string): boolean {
  const decoded = value.replace(/&#x?[0-9a-f]+;?/gi, (entity) => {
    const hex = /^&#x/i.test(entity)
    const digits = entity.replace(/^&#x?/i, "").replace(/;$/, "")
    const code = Number.parseInt(digits, hex ? 16 : 10)
    return Number.isFinite(code) ? String.fromCharCode(code) : ""
  })
  // Drop every space and control character by code point rather than with a
  // control-character regex: `java\tscript:` and `java\0script:` both
  // execute, and a `no-control-regex` lint suppression is not allowed here.
  let collapsed = ""
  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f) continue
    collapsed += char
  }
  collapsed = collapsed.toLowerCase()
  return EMAIL_UNSAFE_URL_SCHEMES.some((scheme) => collapsed.startsWith(scheme))
}

/** Replace script-bearing attribute values with `#`, keep the rest verbatim. */
function neutralizeUnsafeUrls(html: string): string {
  return html.replace(ATTR_VALUE_RE, (match, prefix: string, _raw, dq, sq, bare) => {
    const value: string = dq ?? sq ?? bare ?? ""
    if (!isUnsafeEmailUrl(value)) return match
    return `${prefix}"#"`
  })
}

/**
 * Sanitised copy of a provider HTML body. Returns null for empty input.
 * The result is still HTML — it is stored, never handed to the browser in
 * P0 (see the header).
 */
export function sanitizeEmailHtml(html: string | null | undefined): string | null {
  if (typeof html !== "string" || html.trim().length === 0) return null
  let out = dropUnsafeElements(html)
  out = out.replace(EVENT_HANDLER_ATTR_RE, "")
  out = out.replace(UNSAFE_ATTR_RE, "")
  out = neutralizeUnsafeUrls(out)
  return out.trim().length === 0 ? null : out
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
  "#x2f": "/",
  "#47": "/",
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    const known = HTML_ENTITIES[name.toLowerCase()]
    if (known !== undefined) return known
    if (name.startsWith("#")) {
      const hex = /^#x/i.test(name)
      const code = Number.parseInt(name.replace(/^#x?/i, ""), hex ? 16 : 10)
      // Only decode printable BMP characters: never resurrect control chars.
      if (Number.isFinite(code) && code >= 0x20 && code <= 0xffff) {
        return String.fromCharCode(code)
      }
    }
    return match
  })
}

/** Tags that imply a line break when flattening HTML to text. */
const BLOCK_BREAK_RE =
  /<\s*\/?\s*(?:br|p|div|tr|li|ul|ol|table|h[1-6]|blockquote|pre|section|article|hr)\b[^>]*>/gi

/**
 * Private-use sentinel standing in for "a block boundary was here". Adjacent
 * block tags (`</div><p>`) must collapse to ONE line break, while a blank
 * line the author actually typed must survive — marking boundaries first and
 * collapsing runs of markers afterwards is what tells the two apart.
 */
const BLOCK_MARKER = ""
const BLOCK_MARKER_RUN_RE = new RegExp(`(?:[ \\t]*${BLOCK_MARKER}[ \\t]*)+`, "g")

/**
 * Flatten an HTML body to readable plain text. Used when the provider sent
 * no `text/plain` alternative; the result is what the API returns and the
 * UI renders (React escapes it, so it can contain any characters safely).
 */
export function emailHtmlToText(html: string | null | undefined): string {
  if (typeof html !== "string" || html.length === 0) return ""
  let out = dropUnsafeElements(html.split(BLOCK_MARKER).join(""))
  out = out.replace(BLOCK_BREAK_RE, BLOCK_MARKER)
  out = out.replace(TAG_RE, "")
  out = out.replace(BLOCK_MARKER_RUN_RE, "\n")
  out = decodeHtmlEntities(out)
  out = out.replace(/\r\n?/g, "\n")
  out = out
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
  out = out.replace(/\n{3,}/g, "\n\n")
  return out.trim()
}

/**
 * The body text to store and serve: the provider's text part when there is
 * one, otherwise a flattened rendering of its HTML.
 */
export function emailDisplayText(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
): string {
  if (typeof bodyText === "string" && bodyText.trim().length > 0) {
    return bodyText.replace(/\r\n?/g, "\n").trim()
  }
  return emailHtmlToText(bodyHtml)
}

/** Single-line preview for thread lists. Never longer than the column. */
export function emailSnippetOf(
  bodyText: string | null | undefined,
  bodyHtml?: string | null,
): string | null {
  const text = emailDisplayText(bodyText, bodyHtml).replace(/\s+/g, " ").trim()
  return text.length === 0 ? null : text.slice(0, 280)
}
