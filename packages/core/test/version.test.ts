import { describe, expect, it } from "vitest";
import { userAgent } from "../src/index.js";

describe("userAgent", () => {
  it("identifies as SEO-Notary and never spoofs a search engine", () => {
    const ua = userAgent("1.2.3");
    expect(ua).toBe("SEO-Notary/1.2.3 (+https://seonotary.com)");
    expect(ua.toLowerCase()).not.toContain("googlebot");
  });
});
