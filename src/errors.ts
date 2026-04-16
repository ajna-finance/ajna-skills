import type { ErrorEnvelope } from "./types.js";

const REDACTED_DETAIL_KEYS = new Set(["reason", "cause", "message", "error", "stack"]);
const SAFE_STRING_DETAIL_KEYS = new Set([
  "address",
  "actorAddress",
  "approvalScope",
  "approvalTarget",
  "collateralAddress",
  "collateralType",
  "contractAddress",
  "contractKind",
  "expected",
  "expiresAt",
  "factoryAddress",
  "hash",
  "label",
  "left",
  "name",
  "network",
  "owner",
  "poolAddress",
  "positionType",
  "quoteAddress",
  "replacementHash",
  "replacementReason",
  "right",
  "signatureReason",
  "signatureStatus",
  "signer",
  "spender",
  "tokenAddress",
  "tokenId",
  "tokenStandard",
  "waitErrorCode"
]);

export class AjnaSkillError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function errorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof AjnaSkillError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: sanitizeCuratedMessage(error.message),
        details: sanitizeErrorDetails(error.details)
      }
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      error: {
        code: "UNEXPECTED_ERROR",
        message: "Unexpected failure",
        details: sanitizeErrorDetails({
          name: error.name
        })
      }
    };
  }

  return {
    ok: false,
    error: {
      code: "UNKNOWN_ERROR",
      message: "Unknown failure"
    }
  };
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
  details?: Record<string, unknown>
): asserts condition {
  if (!condition) {
    throw new AjnaSkillError(code, message, details);
  }
}

function sanitizeCuratedMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 160);
}

function sanitizeErrorDetails(
  details: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }

  const sanitizedEntries = Object.entries(details)
    .slice(0, 20)
    .map(([key, value]) => [key, sanitizeDetailValue(value, key)] satisfies [string, unknown]);

  return Object.fromEntries(sanitizedEntries);
}

function sanitizeDetailValue(value: unknown, key?: string): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const collapsed = value.replace(/\s+/g, " ").trim().slice(0, 160);

    if (key && REDACTED_DETAIL_KEYS.has(key)) {
      return "UPSTREAM_ERROR_REDACTED";
    }

    if (key && SAFE_STRING_DETAIL_KEYS.has(key) && isSafeDetailString(collapsed)) {
      return collapsed;
    }

    return "UNSAFE_TEXT_REDACTED";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeDetailValue(entry, key));
  }

  if (typeof value === "object") {
    return sanitizeErrorDetails(value as Record<string, unknown>);
  }

  return "UNSAFE_VALUE_REDACTED";
}

function isSafeDetailString(value: string): boolean {
  return (
    /^0x[a-fA-F0-9]{4,}$/.test(value) ||
    /^[0-9]{1,80}$/.test(value) ||
    /^\d{4}-\d{2}-\d{2}T/.test(value) ||
    /^[A-Za-z0-9._+\-/ ]{1,64}$/.test(value)
  );
}
