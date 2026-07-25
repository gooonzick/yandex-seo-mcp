import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { safeError } from "./errors.js";

export interface ResultLimits {
  maxRows: number;
  maxBytes: number;
}

function truncateArrays(value: unknown, maxRows: number): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, maxRows).map((item) => truncateArrays(item, maxRows));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, truncateArrays(item, maxRows)]),
    );
  }
  return value;
}

export function successResult(data: unknown, limits: ResultLimits): CallToolResult {
  const limited = truncateArrays(data, limits.maxRows);
  let text = JSON.stringify(limited, null, 2);
  let truncated = false;
  if (Buffer.byteLength(text, "utf8") > limits.maxBytes) {
    text = `${text.slice(0, limits.maxBytes)}\n… result truncated by byte limit`;
    truncated = true;
  }

  const structured =
    limited && typeof limited === "object" && !Array.isArray(limited)
      ? (limited as Record<string, unknown>)
      : { data: limited };

  return {
    content: [{ type: "text", text }],
    structuredContent: {
      ...structured,
      _meta: {
        ...(structured._meta &&
        typeof structured._meta === "object" &&
        !Array.isArray(structured._meta)
          ? (structured._meta as Record<string, unknown>)
          : {}),
        truncated,
        maxRows: limits.maxRows,
        maxBytes: limits.maxBytes,
      },
    },
  };
}

export function errorResult(error: unknown): CallToolResult {
  const safe = safeError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(safe, null, 2) }],
    structuredContent: safe,
  };
}

export async function handleTool(
  operation: () => Promise<unknown>,
  limits: ResultLimits,
): Promise<CallToolResult> {
  try {
    return successResult(await operation(), limits);
  } catch (error) {
    return errorResult(error);
  }
}
