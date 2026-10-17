export const VERSION = "0.1.0-alpha.0";

export function userAgent(version: string = VERSION): string {
  return `SEO-Notary/${version} (+https://seonotary.com)`;
}
