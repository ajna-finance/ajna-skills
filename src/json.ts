export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );

    return Object.fromEntries(entries.map(([key, nested]) => [key, sortValue(nested)]));
  }

  return value;
}

export function parseJsonArgument<T>(raw: string | undefined): T {
  if (!raw) {
    throw new Error("Missing JSON payload argument");
  }

  return JSON.parse(raw) as T;
}

