import { describe, expect, test } from "bun:test"
import {
  emailDisplayText,
  emailHtmlToText,
  emailSnippetOf,
  isUnsafeEmailUrl,
  sanitizeEmailHtml,
} from "./sanitize"

describe("email/sanitize/html", () => {
  test("script elements are removed with their contents", () => {
    const out = sanitizeEmailHtml("<p>hi</p><script>alert(document.cookie)</script>")
    expect(out).toBe("<p>hi</p>")
    expect(out).not.toContain("alert")
  })

  test("style, iframe, object, embed, form, svg and meta are removed", () => {
    for (const tag of ["style", "iframe", "object", "embed", "form", "svg", "meta", "noscript"]) {
      const out = sanitizeEmailHtml(`<p>keep</p><${tag}>danger</${tag}>`) ?? ""
      expect(out, tag).toBe("<p>keep</p>")
    }
  })

  test("unclosed dangerous tags are removed too", () => {
    expect(sanitizeEmailHtml("<p>a</p><iframe src=//evil.test>")).toBe("<p>a</p>")
  })

  test("comments (including conditional comments) are removed", () => {
    expect(sanitizeEmailHtml("<p>a</p><!--[if IE]><script>x()</script><![endif]-->")).toBe(
      "<p>a</p>",
    )
  })

  test("event handler attributes are stripped", () => {
    const out = sanitizeEmailHtml(`<img src="x.png" onerror="steal()" ONLOAD='go()'>`) ?? ""
    expect(out).not.toContain("onerror")
    expect(out).not.toContain("ONLOAD")
    expect(out).toContain("src=")
  })

  test("javascript: and data: urls are neutralised to #", () => {
    const out = sanitizeEmailHtml(`<a href="javascript:alert(1)">x</a>`) ?? ""
    expect(out).toBe(`<a href="#">x</a>`)
    expect(sanitizeEmailHtml(`<a href="data:text/html,<script>x</script>">y</a>`) ?? "").toContain(
      `href="#"`,
    )
  })

  test("obfuscated javascript urls are still caught", () => {
    expect(isUnsafeEmailUrl("java\tscript:alert(1)")).toBe(true)
    expect(isUnsafeEmailUrl("JaVaScRiPt&#58;alert(1)")).toBe(true)
    expect(isUnsafeEmailUrl(" vbscript:msgbox(1)")).toBe(true)
    expect(isUnsafeEmailUrl("https://example.com/safe")).toBe(false)
    expect(isUnsafeEmailUrl("mailto:ada@example.com")).toBe(false)
  })

  test("style attributes are dropped (css reaches script)", () => {
    const out = sanitizeEmailHtml(`<div style="width:expression(alert(1))">a</div>`) ?? ""
    expect(out).not.toContain("expression")
    expect(out).not.toContain("style=")
  })

  test("srcdoc and formaction are dropped", () => {
    const out = sanitizeEmailHtml(
      `<button formaction="javascript:x()" srcdoc="<script>">b</button>`,
    )
    expect(out ?? "").not.toContain("srcdoc")
    expect(out ?? "").not.toContain("formaction")
  })

  test("ordinary formatting survives", () => {
    const html = `<p><strong>Hi</strong> <a href="https://example.com">link</a></p>`
    expect(sanitizeEmailHtml(html)).toBe(html)
  })

  test("empty input yields null", () => {
    expect(sanitizeEmailHtml(null)).toBeNull()
    expect(sanitizeEmailHtml("   ")).toBeNull()
    expect(sanitizeEmailHtml("<script>x()</script>")).toBeNull()
  })
})

describe("email/sanitize/text", () => {
  test("html flattens to readable text with script bodies dropped", () => {
    const text = emailHtmlToText("<div>Hello <b>Ada</b><script>alert(1)</script></div><p>Bye</p>")
    expect(text).toBe("Hello Ada\nBye")
    expect(text).not.toContain("alert")
  })

  test("block elements and <br> become line breaks", () => {
    expect(emailHtmlToText("a<br>b<br/>c")).toBe("a\nb\nc")
    expect(emailHtmlToText("<ul><li>one</li><li>two</li></ul>")).toBe("one\ntwo")
  })

  test("entities decode, control-point entities do not", () => {
    expect(emailHtmlToText("<p>a &amp; b &lt;tag&gt; &nbsp;c &#39;q&#39;</p>")).toBe(
      "a & b <tag> c 'q'",
    )
    expect(emailHtmlToText("<p>x&#0;y</p>")).toContain("&#0;")
  })

  test("the text part wins over html when both are present", () => {
    expect(emailDisplayText("plain body", "<p>html body</p>")).toBe("plain body")
  })

  test("html is flattened when there is no text part", () => {
    expect(emailDisplayText(null, "<p>html body</p>")).toBe("html body")
    expect(emailDisplayText("   ", "<p>html body</p>")).toBe("html body")
    expect(emailDisplayText(null, null)).toBe("")
  })

  test("snippets collapse whitespace and clamp to the column width", () => {
    expect(emailSnippetOf("  hello\n\n  world  ")).toBe("hello world")
    expect(emailSnippetOf("x".repeat(400))?.length).toBe(280)
    expect(emailSnippetOf("")).toBeNull()
    expect(emailSnippetOf(null, "<p>from html</p>")).toBe("from html")
  })
})
