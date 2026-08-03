import { describe, expect, it } from "vitest";
import { createCrawlIssueFingerprint } from "../src/crawler/issue-fingerprint.js";
import { CRAWL_FINGERPRINT_VERSION } from "../src/storage/schema.js";
import type { CrawlIssue } from "../src/storage/schema.js";

const stableCategories: Array<{
  category: CrawlIssue["category"];
  code: string;
}> = [
  { category: "redirect", code: "REDIRECT_CHAIN" },
  { category: "canonical", code: "CANONICAL_MISMATCH" },
  { category: "metadata", code: "SHORT_TITLE" },
  { category: "indexing", code: "NOINDEX" },
];

describe("crawl issue fingerprint", () => {
  it.each(stableCategories)(
    "keeps $category identity stable when observed details change",
    ({ category, code }) => {
      const first = createCrawlIssueFingerprint({
        targetUrl: "https://example.com/",
        pageUrl: "HTTPS://EXAMPLE.COM:443/page?b=2&a=1#first",
        code,
        category,
        relatedUrl: "https://example.com/old-target",
        details: { message: "first wording", observedValue: 10 },
      });
      const second = createCrawlIssueFingerprint({
        targetUrl: "https://example.com/",
        pageUrl: "https://example.com/page?a=1&b=2#second",
        code: code.toLowerCase(),
        category,
        relatedUrl: "https://example.com/new-target",
        details: { message: "rewritten wording", observedValue: 999 },
      });

      expect(first).toEqual(second);
      expect(first.fingerprintVersion).toBe(CRAWL_FINGERPRINT_VERSION);
      expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it("uses the related URL to distinguish link issues on one page", () => {
    const fingerprint = (relatedUrl: string, details: Record<string, unknown>) =>
      createCrawlIssueFingerprint({
        targetUrl: "https://example.com/",
        pageUrl: "https://example.com/source",
        code: "BROKEN_INTERNAL_LINK",
        category: "link",
        relatedUrl,
        details,
      }).fingerprint;

    expect(
      fingerprint("https://example.com/broken?b=2&a=1#old", { status: 404, text: "Old" }),
    ).toBe(fingerprint("https://example.com/broken?a=1&b=2#new", { status: 500, text: "New" }));
    expect(fingerprint("https://example.com/broken-a", {})).not.toBe(
      fingerprint("https://example.com/broken-b", {}),
    );
  });

  it("distinguishes issue codes and page scopes", () => {
    const fingerprint = (pageUrl: string, code: string) =>
      createCrawlIssueFingerprint({
        targetUrl: "https://example.com/",
        pageUrl,
        code,
        category: "metadata",
      }).fingerprint;

    expect(fingerprint("https://example.com/a", "SHORT_TITLE")).not.toBe(
      fingerprint("https://example.com/b", "SHORT_TITLE"),
    );
    expect(fingerprint("https://example.com/a", "SHORT_TITLE")).not.toBe(
      fingerprint("https://example.com/a", "LONG_TITLE"),
    );
  });
});
