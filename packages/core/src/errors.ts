import { sanitizeText } from "./sanitize.js";

export const OPERATIONAL_ERROR_CODES = [
  "INVALID_INPUT",
  "POLICY_BLOCKED",
  "DNS_FAILURE",
  "TIMEOUT",
  "BODY_TOO_LARGE",
  "TOO_MANY_REDIRECTS",
  "REDIRECT_LOOP",
  "REDIRECT_INVALID",
  "NETWORK_ERROR",
  "BROWSER_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type OperationalErrorCode = (typeof OPERATIONAL_ERROR_CODES)[number];

/** Operational failure: never produces a report; CLI/MCP map it to exit code 2 / isError. */
export class NotaryError extends Error {
  readonly code: OperationalErrorCode;

  constructor(code: OperationalErrorCode, message: string, options?: { cause?: unknown }) {
    super(sanitizeText(message, 500), options);
    this.name = "NotaryError";
    this.code = code;
  }
}
