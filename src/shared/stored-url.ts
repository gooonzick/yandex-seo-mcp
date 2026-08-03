import { normalizeCrawlUrl } from "../storage/schema.js";

export const DEFAULT_SECRET_QUERY_KEYS = [
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "code",
  "credential",
  "key",
  "password",
  "secret",
  "session",
  "sessionid",
  "sid",
  "token",
] as const;

export function sanitizeStoredUrl(value: string, denylistValues: readonly string[]): string {
  const denylist = new Set(denylistValues.map((key) => key.trim().toLowerCase()).filter(Boolean));
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (denylist.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  return normalizeCrawlUrl(url.href);
}
