function isUnsafe(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) || // zero-width and directional marks
    (cp >= 0x202a && cp <= 0x202e) || // bidi embedding/override
    (cp >= 0x2060 && cp <= 0x2069) || // word joiner, bidi isolates
    cp === 0xfeff
  );
}

/** Strips control/bidi characters, collapses whitespace, truncates by code points. */
export function sanitizeText(input: unknown, max = 300): string {
  const raw = typeof input === "string" ? input : String(input ?? "");
  let out = "";
  let count = 0;
  let pendingSpace = false;
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isUnsafe(cp) || /\s/u.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (count + (pendingSpace ? 1 : 0) >= max) return `${out}…`;
    if (pendingSpace) {
      out += " ";
      count++;
      pendingSpace = false;
    }
    out += ch;
    count++;
  }
  return out;
}

/** Keeps origin, path and query keys; replaces query values and drops userinfo/fragment. */
export function redactUrl(raw: string, max = 500): string {
  try {
    const u = new URL(raw);
    const keys = [...u.searchParams.keys()].map((k) => `${encodeURIComponent(k)}=REDACTED`);
    const query = keys.length > 0 ? `?${keys.join("&")}` : "";
    return sanitizeText(`${u.origin}${u.pathname}${query}`, max);
  } catch {
    return sanitizeText(raw.split("?")[0] ?? "", max);
  }
}
