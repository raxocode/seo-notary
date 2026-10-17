// Runs inside the page. Page-controlled values are coerced and bounded again on the Node side.
export const SNAPSHOT_SCRIPT = String.raw`(() => {
  const clean = (s) => (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  const resolve = (href) => {
    try {
      const u = new URL(href, document.baseURI);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : href;
    } catch (e) {
      return href;
    }
  };
  let description = null;
  const robots = [];
  for (const m of document.querySelectorAll("meta[name]")) {
    const name = clean(m.getAttribute("name")).toLowerCase();
    const content = m.getAttribute("content");
    if (content == null) continue;
    if (name === "description" && description === null) description = clean(content);
    else if (name === "robots" || /^[a-z0-9-]*bot$/.test(name)) {
      for (const t of content.split(",")) {
        const token = clean(t).toLowerCase();
        if (token) robots.push(name === "robots" ? token : name + ":" + token);
      }
    }
  }
  let canonical = null;
  const resolved = [];
  const rawHrefs = [];
  for (const l of document.querySelectorAll("link[rel]")) {
    if (!clean(l.getAttribute("rel")).toLowerCase().split(" ").includes("canonical")) continue;
    const href = l.getAttribute("href");
    rawHrefs.push(href == null ? null : clean(href));
    resolved.push(href == null || clean(href) === "" ? null : resolve(clean(href)));
  }
  const firstValid = resolved.find((h) => h !== null && /^https?:/i.test(h));
  canonical = firstValid !== undefined ? firstValid : (rawHrefs[0] || null);
  const text = document.body ? String(document.body.innerText || "").slice(0, 1000000) : "";
  let words = 0;
  for (const w of text.split(/\s+/)) if (w) words++;
  return { title: clean(document.title), description, canonical, robots, words };
})()`;
