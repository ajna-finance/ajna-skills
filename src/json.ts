import { AjnaSkillError } from "./errors.js";

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );

    return Object.fromEntries(entries.map(([key, nested]) => [key, sortValue(nested)]));
  }

  return value;
}

export function parseJsonArgument<T>(raw: string | undefined): T {
  if (!raw) {
    throw new Error("Missing JSON payload argument");
  }

  const parsed = JSON.parse(raw) as T;
  assertJsonNumbersSafe(parsed, "$");
  return parsed;
}

function assertJsonNumbersSafe(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonNumbersSafe(entry, `${path}[${index}]`));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      assertJsonNumbersSafe(nested, `${path}.${key}`);
    }
    return;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new AjnaSkillError(
        "UNSAFE_JSON_NUMBER",
        "JSON numeric values must be safe integers; pass large integers as strings",
        {
          path,
          value
        }
      );
    }
  }
}
