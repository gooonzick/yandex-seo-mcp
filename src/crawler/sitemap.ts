import { gunzipSync } from "node:zlib";
import * as cheerio from "cheerio";
import type { SitemapEntry } from "./types.js";

export interface ParsedSitemap {
  entries: SitemapEntry[];
  childSitemaps: string[];
}

export function decodeSitemap(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const decoded =
    buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer;
  return decoded.toString("utf8");
}

export function parseSitemap(xml: string, source: string): ParsedSitemap {
  const $ = cheerio.load(xml, { xmlMode: true });
  const entries: SitemapEntry[] = [];
  $("url").each((_index, element) => {
    const location = $(element).find("loc").first().text().trim();
    if (!location) return;
    try {
      const url = new URL(location, source).href;
      const lastModified = $(element).find("lastmod").first().text().trim();
      entries.push({
        url,
        source,
        ...(lastModified ? { lastModified } : {}),
      });
    } catch {
      // Ignore invalid Sitemap entries.
    }
  });
  const childSitemaps: string[] = [];
  $("sitemap > loc").each((_index, element) => {
    try {
      childSitemaps.push(new URL($(element).text().trim(), source).href);
    } catch {
      // Ignore invalid child Sitemap declarations.
    }
  });
  return { entries, childSitemaps };
}
