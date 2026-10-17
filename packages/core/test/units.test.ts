import { describe, expect, it } from "vitest";
import { redactUrl, sanitizeText } from "../src/index.js";
import { decodeBody, isNoindex, parseHtml, parseXRobotsTag } from "../src/html.js";

describe("sanitizeText", () => {
  it("strips control, ANSI escape and bidi characters and collapses whitespace", () => {
    const out = sanitizeText("a\u001b[31mred\u0000\u202eevil\n\t  b");
    expect([...out].every((ch) => ch.codePointAt(0)! > 0x1f && ch !== "\u202e")).toBe(true);
    expect(out).toContain("red");
    expect(out.endsWith(" b")).toBe(true);
  });
  it("truncates by code points with an ellipsis", () => {
    expect(sanitizeText("x".repeat(500), 10)).toBe(`${"x".repeat(10)}…`);
    expect(sanitizeText("😀".repeat(20), 5)).toBe(`${"😀".repeat(5)}…`);
  });
  it("leaves short text untouched", () => {
    expect(sanitizeText("hello world")).toBe("hello world");
  });
});

describe("redactUrl", () => {
  it("keeps keys, redacts values, drops fragment and userinfo", () => {
    const out = redactUrl("https://u:p@example.test/a/b?token=s3cret&x=1#frag");
    expect(out).toBe("https://example.test/a/b?token=REDACTED&x=REDACTED");
    expect(out).not.toContain("s3cret");
  });
  it("handles unparseable input without leaking the query", () => {
    expect(redactUrl("not a url?token=abc")).not.toContain("abc");
  });
});

describe("parseHtml", () => {
  it("extracts basics and counts visible words only", () => {
    const p = parseHtml(
      `<html><head><title> Hi\n there </title><meta name="Description" content=" d  e "><link rel="Canonical nofollow" href=" /x ">
       <meta name="robots" content="NoIndex, nofollow"><meta name="googlebot" content="noarchive"><base href="/base/"></head>
       <body>one two <script>var a = "ignored words here";</script><style>.a{}</style><noscript>hidden words</noscript><template>tpl words</template> three</body></html>`,
    );
    expect(p.title).toBe("Hi there");
    expect(p.metaDescription).toBe("d e");
    expect(p.canonicals).toEqual([{ href: "/x" }]);
    expect(p.metaRobots).toEqual(["noindex", "nofollow", "googlebot:noarchive"]);
    expect(p.baseHref).toBe("/base/");
    expect(p.wordCount).toBe(3);
  });
  it("ignores an SVG <title> and uses the first HTML title", () => {
    const p = parseHtml(`<body><svg><title>svg title</title></svg></body><title>real</title>`);
    expect(p.title).toBe("real");
  });
  it("reports absent title as null and empty/whitespace title as empty string", () => {
    expect(parseHtml("<html><head></head><body>x</body></html>").title).toBeNull();
    expect(parseHtml("<title>   </title>").title).toBe("");
  });
  it("survives empty input, unclosed tags and deep nesting", () => {
    expect(parseHtml("").title).toBeNull();
    expect(parseHtml("<div><p><b><title>x").title).toBe("x");
    const deep = "<div>".repeat(20_000) + "word";
    expect(() => parseHtml(deep)).not.toThrow();
  });
  it("collects JSON-LD blocks and canonical links without href", () => {
    const p = parseHtml(`<link rel="canonical"><script type="APPLICATION/LD+JSON">{}</script><script>{}</script>`);
    expect(p.canonicals).toEqual([{ href: null }]);
    expect(p.jsonLd).toEqual(["{}"]);
  });
});

describe("decodeBody", () => {
  it("honors Content-Type charset", () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeBody(bytes, "text/html; charset=iso-8859-1")).toBe("café");
  });
  it("falls back to UTF-8 for an unknown charset label", () => {
    const bytes = new TextEncoder().encode("<title>héllo</title>");
    expect(decodeBody(bytes, "text/html; charset=definitely-not-real")).toBe("<title>héllo</title>");
  });
  it("sniffs <meta charset> and BOM", () => {
    const meta = new Uint8Array([...new TextEncoder().encode('<meta charset="iso-8859-1">'), 0xe9]);
    expect(decodeBody(meta, null).endsWith("é")).toBe(true);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    expect(decodeBody(bom, "text/html; charset=iso-8859-1").endsWith("a")).toBe(true);
  });
});

describe("X-Robots-Tag", () => {
  it("parses agent prefixes and plain directives", () => {
    expect(parseXRobotsTag(["noindex, nofollow"])).toEqual(["noindex", "nofollow"]);
    expect(parseXRobotsTag(["googlebot: noindex"])).toEqual(["googlebot:noindex"]);
    expect(parseXRobotsTag(["unavailable_after: 25 Jun 2030 15:00:00 PST"])[0]).toContain("unavailable_after");
  });
  it("detects noindex and none", () => {
    expect(isNoindex(["nofollow"])).toBeNull();
    expect(isNoindex(["googlebot:noindex"])).toBe("googlebot:noindex");
    expect(isNoindex(["none"])).toBe("none");
  });
});
