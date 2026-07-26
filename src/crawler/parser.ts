import * as cheerio from "cheerio";
import type { PageMetadata } from "./types.js";

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function resolveUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function jsonLdTypes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdTypes);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  const own = Array.isArray(type)
    ? type.filter((item): item is string => typeof item === "string")
    : typeof type === "string"
      ? [type]
      : [];
  return [...own, ...Object.values(record).flatMap(jsonLdTypes)];
}

export function parseHtml(html: string, pageUrl: string, origin: string): PageMetadata {
  const $ = cheerio.load(html, { baseURI: pageUrl });
  const links = new Set<string>();
  $("a[href]").each((_index, element) => {
    const resolved = resolveUrl($(element).attr("href"), pageUrl);
    if (resolved) links.add(resolved);
  });
  const internalLinks: string[] = [];
  const externalLinks: string[] = [];
  for (const link of links) {
    if (new URL(link).origin === origin) internalLinks.push(link);
    else externalLinks.push(link);
  }
  const structuredDataTypes = new Set<string>();
  $('script[type="application/ld+json"]').each((_index, element) => {
    try {
      const value = JSON.parse($(element).text()) as unknown;
      for (const type of jsonLdTypes(value)) structuredDataTypes.add(type);
    } catch {
      structuredDataTypes.add("INVALID_JSON_LD");
    }
  });
  const robots = [
    ...($('meta[name="robots" i]').attr("content") ?? "").split(","),
    ...($('meta[name="yandex" i]').attr("content") ?? "").split(","),
  ]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const canonical = resolveUrl($('link[rel="canonical" i]').attr("href"), pageUrl) ?? null;
  const hreflang: Array<{ language: string; url: string }> = [];
  $('link[rel="alternate" i][hreflang][href]').each((_index, element) => {
    const language = $(element).attr("hreflang");
    const url = resolveUrl($(element).attr("href"), pageUrl);
    if (language && url) hreflang.push({ language, url });
  });
  const description = $('meta[name="description" i]').attr("content");
  return {
    title: cleanText($("title").first().text()) || null,
    description: description ? cleanText(description) : null,
    h1: $("h1")
      .map((_index, element) => cleanText($(element).text()))
      .get()
      .filter(Boolean),
    canonical,
    robots,
    hreflang,
    structuredDataTypes: [...structuredDataTypes],
    internalLinks: [...internalLinks],
    externalLinks: [...externalLinks],
  };
}
