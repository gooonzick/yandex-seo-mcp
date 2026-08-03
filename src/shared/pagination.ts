import { createHash } from "node:crypto";
import { z } from "zod";
import { YandexApiError } from "./errors.js";

export const CURSOR_VERSION = 1 as const;
export const MAX_CURSOR_LENGTH = 2_048;

const cursorSchema = z
  .object({
    version: z.literal(CURSOR_VERSION),
    scope: z.string().length(64),
    order: z.enum(["asc", "desc"]),
    after: z.string().min(1).max(4_096),
  })
  .strict();

export interface CursorPage<T> {
  items: T[];
  pageInfo: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export function createPaginationInputSchema(maxLimit = 200, defaultLimit = 50) {
  return z.object({
    cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
    limit: z.number().int().min(1).max(maxLimit).default(defaultLimit),
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value ?? null;
}

export function createPaginationScope(resource: string, filters: unknown = null): string {
  return createHash("sha256")
    .update(JSON.stringify([resource, canonicalize(filters)]))
    .digest("hex");
}

function invalidCursor(): YandexApiError {
  return new YandexApiError(
    "VALIDATION",
    "Invalid or incompatible pagination cursor; restart pagination without a cursor",
  );
}

function decodeCursor(value: string, scope: string, order: "asc" | "desc") {
  try {
    if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (parsed.scope !== scope || parsed.order !== order) throw invalidCursor();
    return parsed;
  } catch (error) {
    if (error instanceof YandexApiError) throw error;
    throw invalidCursor();
  }
}

function encodeCursor(scope: string, order: "asc" | "desc", after: string): string {
  return Buffer.from(
    JSON.stringify({ version: CURSOR_VERSION, scope, order, after }),
    "utf8",
  ).toString("base64url");
}

export function paginateByKey<T>(
  values: readonly T[],
  options: {
    scope: string;
    cursor?: string | undefined;
    limit: number;
    order: "asc" | "desc";
    getKey: (value: T) => string;
  },
): CursorPage<T> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500)
    throw new YandexApiError("VALIDATION", "Pagination limit must be between 1 and 500");
  if (!/^[a-f0-9]{64}$/.test(options.scope))
    throw new YandexApiError("VALIDATION", "Pagination scope must be a SHA-256 identifier");

  const keyed = values.map((value) => ({ value, key: options.getKey(value) }));
  if (keyed.some(({ key }) => key.length === 0))
    throw new YandexApiError("VALIDATION", "Pagination keys must not be empty");
  if (new Set(keyed.map(({ key }) => key)).size !== keyed.length)
    throw new YandexApiError("VALIDATION", "Pagination keys must be unique");

  const direction = options.order === "asc" ? 1 : -1;
  keyed.sort((left, right) =>
    left.key < right.key ? -direction : left.key > right.key ? direction : 0,
  );
  const decoded = options.cursor
    ? decodeCursor(options.cursor, options.scope, options.order)
    : undefined;
  const remaining = decoded
    ? keyed.filter(({ key }) =>
        options.order === "asc" ? key > decoded.after : key < decoded.after,
      )
    : keyed;
  const selected = remaining.slice(0, options.limit);
  const hasMore = remaining.length > selected.length;
  const lastKey = selected.at(-1)?.key;

  return {
    items: selected.map(({ value }) => value),
    pageInfo: {
      limit: options.limit,
      hasMore,
      nextCursor: hasMore && lastKey ? encodeCursor(options.scope, options.order, lastKey) : null,
    },
  };
}
