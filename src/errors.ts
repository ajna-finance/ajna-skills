import type { ErrorEnvelope } from "./types.js";

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
        message: error.message,
        details: error.details
      }
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      error: {
        code: "UNEXPECTED_ERROR",
        message: error.message
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

