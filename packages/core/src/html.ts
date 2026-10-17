import { parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const HTML_NS = "http://www.w3.org/1999/xhtml";
const HIDDEN_TEXT_TAGS = new Set(["script", "style", "noscript", "template"]);

export interface CanonicalLink {
  /** Trimmed href attribute; null when the attribute is absent. */
  href: string | null;
}

export interface ParsedHtml {
  /** Whitespace-collapsed text of the first HTML-namespace <title>; null when absent. */
  title: string | null;
  metaDescription: string | null;
  canonicals: CanonicalLink[];
  /** Lowercased tokens; agent-specific ones are "agent:token". */
  metaRobots: string[];
  /** First <base href>, unresolved. */
  baseHref: string | null;
  jsonLd: string[];
  /** Whitespace-separated tokens in body text, excluding script/style/noscript/template. */
  wordCount: number;
}

function attr(el: Element, name: string): string | null {
  return el.attrs.find((a) => a.name === name)?.value ?? null;
}

function directText(el: Element): string {
  let out = "";
  for (const c of el.childNodes) if (c.nodeName === "#text") out += (c as DefaultTreeAdapterMap["textNode"]).value;
  return out;
}

export function parseDirectiveList(content: string, agent?: string): string[] {
  return content
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
    .map((t) => (agent ? `${agent}:${t}` : t));
}

export function parseHtml(html: string): ParsedHtml {
  const doc = parse(html);
  const result: ParsedHtml = {
    title: null,
    metaDescription: null,
    canonicals: [],
    metaRobots: [],
    baseHref: null,
    jsonLd: [],
    wordCount: 0,
  };
  const stack: { node: Node; hidden: boolean; inBody: boolean }[] = [{ node: doc, hidden: false, inBody: false }];

  while (stack.length > 0) {
    const { node, hidden, inBody } = stack.pop()!;
    if (node.nodeName === "#text") {
      if (inBody && !hidden) {
        const text = (node as DefaultTreeAdapterMap["textNode"]).value;
        result.wordCount += text.split(/\s+/u).filter((w) => w.length > 0).length;
      }
      continue;
    }
    if (!("tagName" in node)) {
      if ("childNodes" in node) for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push({ node: node.childNodes[i]!, hidden, inBody });
      continue;
    }
    const el = node as Element;
    const tag = el.tagName;
    const isHtml = el.namespaceURI === HTML_NS;

    if (isHtml) {
      if (tag === "title" && result.title === null) {
        result.title = directText(el).replace(/\s+/gu, " ").trim();
      } else if (tag === "meta") {
        const name = attr(el, "name")?.trim().toLowerCase();
        const content = attr(el, "content");
        if (name && content !== null) {
          if (name === "description" && result.metaDescription === null) {
            result.metaDescription = content.replace(/\s+/gu, " ").trim();
          } else if (name === "robots") {
            result.metaRobots.push(...parseDirectiveList(content));
          } else if (/^[a-z0-9-]*bot$/.test(name)) {
            result.metaRobots.push(...parseDirectiveList(content, name));
          }
        }
      } else if (tag === "link") {
        const rel = attr(el, "rel")?.toLowerCase().split(/\s+/u) ?? [];
        if (rel.includes("canonical")) result.canonicals.push({ href: attr(el, "href")?.trim() ?? null });
      } else if (tag === "base" && result.baseHref === null) {
        result.baseHref = attr(el, "href")?.trim() || null;
      } else if (tag === "script" && attr(el, "type")?.trim().toLowerCase() === "application/ld+json") {
        result.jsonLd.push(directText(el));
      }
    }

    const childHidden = hidden || (isHtml && HIDDEN_TEXT_TAGS.has(tag));
    const childInBody = inBody || (isHtml && tag === "body");
    for (let i = el.childNodes.length - 1; i >= 0; i--) stack.push({ node: el.childNodes[i]!, hidden: childHidden, inBody: childInBody });
  }
  return result;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

function tryDecoder(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label.trim().replace(/^["']|["']$/g, ""));
  } catch {
    return null;
  }
}

/** BOM, then Content-Type charset, then <meta charset> in the first 1024 bytes, else UTF-8. Never throws. */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  let decoder: TextDecoder | null = null;
  if (bytes.length >= 3 && UTF8_BOM.every((b, i) => bytes[i] === b)) decoder = new TextDecoder("utf-8");
  else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) decoder = new TextDecoder("utf-16le");
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) decoder = new TextDecoder("utf-16be");

  if (!decoder && contentType) {
    const m = /charset\s*=\s*("[^"]*"|[^\s;]+)/i.exec(contentType);
    if (m?.[1]) decoder = tryDecoder(m[1]);
  }
  if (!decoder) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(head);
    if (m?.[1]) decoder = tryDecoder(m[1]);
  }
  return (decoder ?? new TextDecoder("utf-8")).decode(bytes);
}

const KNOWN_VALUE_DIRECTIVES = new Set(["unavailable_after", "max-snippet", "max-image-preview", "max-video-preview"]);

/** X-Robots-Tag values: optional leading "agent:" prefix, comma-separated directives. */
export function parseXRobotsTag(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    let rest = value.trim();
    let agent: string | undefined;
    const m = /^([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(rest);
    if (m && !KNOWN_VALUE_DIRECTIVES.has((m[1] ?? "").toLowerCase())) {
      agent = (m[1] ?? "").toLowerCase();
      rest = m[2] ?? "";
    }
    out.push(...parseDirectiveList(rest, agent));
  }
  return out;
}

export function isNoindex(directives: readonly string[]): string | null {
  return directives.find((d) => /(^|:)(noindex|none)$/.test(d)) ?? null;
}
