import { createHash } from "node:crypto";
import {
  CRAWL_FINGERPRINT_VERSION,
  normalizeCrawlUrl,
  type CrawlIssue,
} from "../storage/schema.js";

export interface CrawlIssueFingerprintInput {
  targetUrl: string;
  pageUrl: string | null;
  code: string;
  category: CrawlIssue["category"];
  relatedUrl?: string | null;
  details?: Readonly<Record<string, unknown>>;
}

export interface CrawlIssueFingerprint {
  fingerprint: string;
  fingerprintVersion: number;
}

/**
 * Builds issue identity only from stable dimensions. Human-readable details and
 * observed values are deliberately excluded so they can change between crawls.
 */
export function createCrawlIssueFingerprint(
  input: CrawlIssueFingerprintInput,
): CrawlIssueFingerprint {
  const scopeUrl = normalizeCrawlUrl(input.pageUrl ?? input.targetUrl);
  const relatedUrl =
    input.category === "link" && input.relatedUrl ? normalizeCrawlUrl(input.relatedUrl) : null;
  const identity = [
    CRAWL_FINGERPRINT_VERSION,
    input.category,
    input.code.trim().toUpperCase(),
    scopeUrl,
    relatedUrl,
  ];
  return {
    fingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    fingerprintVersion: CRAWL_FINGERPRINT_VERSION,
  };
}
