import { YandexApiError } from "../shared/errors.js";

// Node 24 exposes the original JSON number lexeme to revivers.
export function parseDirectJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return context?.source ?? String(value);
    }
    return value;
  });
}

export function stringifyDirectJson(value: unknown): string {
  const raw = JSON as typeof JSON & { rawJSON: (text: string) => unknown };
  const normalize = (item: unknown, key: string): unknown => {
    if (
      typeof item === "number" &&
      (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))
    ) {
      throw new YandexApiError(
        "VALIDATION",
        "Unsafe numeric value; pass large IDs as decimal strings",
      );
    }
    if (typeof item === "string" && /(?:^Id$|Id$|Ids$)/.test(key) && /^-?[0-9]+$/.test(item)) {
      const id = BigInt(item);
      if (id < -9223372036854775808n || id > 9223372036854775807n) {
        throw new YandexApiError("VALIDATION", "ID exceeds signed int64 range");
      }
      return raw.rawJSON(id.toString());
    }
    if (Array.isArray(item)) return item.map((entry) => normalize(entry, key));
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).map(([name, entry]) => [name, normalize(entry, name)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value, ""));
}
