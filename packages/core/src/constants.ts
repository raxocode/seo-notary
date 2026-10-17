export const SCHEMA_VERSION = "0.1.0" as const;

export interface Limits {
  maxUrlLength: number;
  maxResponseBytes: number;
  maxRobotsTxtBytes: number;
  maxRedirects: number;
  maxHeaderBytes: number;
  hopTimeoutMs: number;
  totalTimeoutMs: number;
  maxEvidenceChars: number;
  maxFindingsPerRule: number;
  titleMinChars: number;
  titleMaxChars: number;
}

// Hard limits are constants, never request fields.
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxUrlLength: 2048,
  maxResponseBytes: 2 * 1024 * 1024,
  maxRobotsTxtBytes: 256 * 1024,
  maxRedirects: 10,
  maxHeaderBytes: 32 * 1024,
  hopTimeoutMs: 10_000,
  totalTimeoutMs: 30_000,
  maxEvidenceChars: 300,
  maxFindingsPerRule: 20,
  titleMinChars: 10,
  titleMaxChars: 70,
});
