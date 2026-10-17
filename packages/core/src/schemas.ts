import { z } from "zod";
import { SCHEMA_VERSION } from "./constants.js";

export const SeveritySchema = z.enum(["error", "warning", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export const RULE_ID_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Strict: unknown keys are rejected. Hard limits are never request fields. */
export const RequestSchema = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  target_url: z.string().min(1).max(2048),
  tier: z.enum(["http", "browser"]).default("http"),
  mode: z.enum(["lean", "faithful"]).optional(),
  rules: z.array(z.string().regex(RULE_ID_PATTERN).max(64)).max(64).optional(),
  fail_on: SeveritySchema.default("error"),
  policy: z.enum(["local", "strict"]).default("local"),
  include_screenshot: z.boolean().default(false),
  check_robots_txt: z.boolean().default(false),
});
export type VerifyRequest = z.output<typeof RequestSchema>;
export type VerifyRequestInput = z.input<typeof RequestSchema>;

const Bounded = (max: number) => z.string().max(max);

export const EvidenceSchema = z.strictObject({
  raw: Bounded(400).optional(),
  rendered: Bounded(400).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const FindingSchema = z.strictObject({
  rule_id: z.string().regex(RULE_ID_PATTERN),
  severity: SeveritySchema,
  category: Bounded(40),
  message: Bounded(400),
  location: Bounded(300).optional(),
  evidence: EvidenceSchema.optional(),
  remediation: Bounded(400).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const RedirectHopSchema = z.strictObject({
  url: Bounded(500),
  status: z.number().int(),
});

export const RawHttpSnapshotSchema = z.strictObject({
  status: z.number().int(),
  final_url: Bounded(2100),
  content_type: Bounded(200).nullable(),
  title: Bounded(400).nullable(),
  meta_description: Bounded(400).nullable(),
  canonical: Bounded(2100).nullable(),
  robots_directives: z.array(Bounded(100)).max(50),
  word_count: z.number().int().nonnegative().nullable(),
  redirect_chain: z.array(RedirectHopSchema).max(20),
});
export type RawHttpSnapshot = z.infer<typeof RawHttpSnapshotSchema>;

// Filled by the browser tier; always null for tier "http".
export const RenderedDomSnapshotSchema = z.strictObject({}).passthrough();

export const ReportSchema = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  target_url: Bounded(2100),
  status: z.enum(["pass", "fail"]),
  execution: z.strictObject({
    tier: z.enum(["http", "browser"]),
    mode: z.enum(["lean", "faithful"]).nullable(),
    runner: z.literal("local"),
    duration_ms: z.number().int().nonnegative(),
    redirects_followed: z.number().int().nonnegative(),
    started_at: z.iso.datetime(),
  }),
  summary: z.strictObject({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
  }),
  snapshots: z.strictObject({
    raw_http: RawHttpSnapshotSchema,
    rendered_dom: RenderedDomSnapshotSchema.nullable(),
  }),
  findings: z.array(FindingSchema),
});
export type Report = z.infer<typeof ReportSchema>;
