import { BROWSER_RULES } from "./browser.js";
import { RULES } from "./rules.js";
import type { Severity } from "./schemas.js";

export interface RuleInfo {
  id: string;
  category: string;
  defaultSeverity: Severity;
  tier: "http" | "browser";
  description: string;
  limitation: string;
}

export const RULE_CATALOG: readonly RuleInfo[] = [...RULES, ...BROWSER_RULES].map((r) => ({
  id: r.id,
  category: r.category,
  defaultSeverity: r.defaultSeverity,
  tier: r.tier,
  description: r.description,
  limitation: r.limitation,
}));

export const RULE_IDS: readonly string[] = RULE_CATALOG.map((r) => r.id);
