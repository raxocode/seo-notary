import type { BrowserCollectInput, BrowserCollector, RenderedDomSnapshot } from "seo-notary-core";
import { NotaryError } from "seo-notary-core";

type BrowserModule = typeof import("seo-notary-browser");

/** Loads seo-notary-browser (and Playwright) only when a browser job is requested. */
export class LazyBrowser implements BrowserCollector {
  private manager: InstanceType<BrowserModule["BrowserManager"]> | null = null;

  async collect(input: BrowserCollectInput): Promise<RenderedDomSnapshot> {
    if (!this.manager) {
      let mod: BrowserModule;
      try {
        mod = await import("seo-notary-browser");
      } catch (err) {
        throw new NotaryError("BROWSER_UNAVAILABLE", "seo-notary-browser could not be loaded", { cause: err });
      }
      this.manager = new mod.BrowserManager();
    }
    return this.manager.collect(input);
  }

  async close(): Promise<void> {
    await this.manager?.close();
    this.manager = null;
  }
}
